// mu — `mu doctor` diagnostic verb (human + --json forms).
//
// Reports:
//   - environment: the active mux + its ambient env facts, $MU_SESSION
//   - db: schema integrity, schema_version, journal_mode, foreign_keys
//   - workstream: auto-detected current workstream
//   - state: per-workstream agent / task / log counts + reconcile drift
//   - disk: state-dir vs DB reconciliation (both directions) + residue
//
// Read-only (the reconcile pass uses mode: "report-only" so polling doesn't
// race in-flight spawns; see bug_agent_spawn_workspace_fk_failure).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { listLiveAgents } from "../agents.js";
import { emitJson, resolveWorkstream } from "../cli.js";
import { CURRENT_SCHEMA_VERSION, type Db, defaultDbPath, EXPECTED_TABLES } from "../db.js";
import { checkDiskRecon, formatBytes, measureWorkspaceUsage } from "../disk-recon.js";
import {
  checkCheapDriftInvariant,
  checkDrift,
  DriftDetectedError,
  driftRemediation,
  formatDriftRecord,
} from "../drift.js";
import { checkFleetHazards, type FleetHazard } from "../fleet-hazards.js";
import { activeMux, type MuxHealth } from "../mux.js";
import { pc } from "../output.js";
import { summarizeWorkstream } from "../workstream.js";

/** Column width for the `label : value` environment block. Wide enough
 *  for the longest label any backend contributes — `$HERDR_WORKSPACE_ID`
 *  at 19 — so the colons stay in one column on every mux. */
const LABEL_WIDTH = 19;
const pad = (s: string): string => s.padEnd(LABEL_WIDTH);

/**
 * Health of the active mux, or undefined when NO backend resolves.
 * Never throws: doctor's whole job is reporting a broken substrate,
 * so `NoMultiplexerError` here is a finding, not a failure.
 */
async function muxHealth(): Promise<MuxHealth | undefined> {
  try {
    return await (await activeMux()).healthCheck();
  } catch {
    return undefined;
  }
}

/** Render a hazard list as doctor rows plus a remediation block per
 *  non-ok finding. Shared by the fleet and disk sections, which differ
 *  only in what they check. Returns true iff anything needs attention. */
function printHazards(hazards: readonly FleetHazard[]): boolean {
  let sawProblem = false;
  for (const hazard of hazards) {
    const colour =
      hazard.severity === "fail" ? pc.red : hazard.severity === "warn" ? pc.yellow : pc.green;
    const label = hazard.severity === "ok" ? "ok" : hazard.severity.toUpperCase();
    console.log(`  ${hazard.name.padEnd(16)} : ${colour(label)} ${pc.dim(hazard.detail)}`);
    if (hazard.severity !== "ok") sawProblem = true;
  }
  for (const hazard of hazards) {
    if (hazard.severity === "ok" || hazard.remediation === undefined) continue;
    console.log("");
    for (const line of hazard.remediation) console.log(`  ${line}`);
  }
  return sawProblem;
}

export async function cmdDoctor(
  db: Db,
  opts: { json?: boolean; deep?: boolean; disk?: boolean } = {},
): Promise<void> {
  if (opts.json) {
    return cmdDoctorJson(db, opts);
  }
  console.log(pc.bold("mu doctor"));

  // ─ Environment
  //
  // The backend reports DATA (name / version / its own env facts);
  // doctor owns every string below. A second mux with different
  // ambient vars needs no change here.
  console.log(pc.bold("\nenvironment"));
  const health = await muxHealth();
  if (health === undefined) {
    console.log(`  multiplexer      : ${pc.red("NONE")} — install tmux ≥ 3.0`);
  } else {
    const label = pad(health.name);
    if (health.ok) console.log(`  ${label}: ${pc.green("ok")} (${health.version ?? "?"})`);
    else console.log(`  ${label}: ${pc.red("NOT FOUND")} — ${health.remediation}`);
    for (const fact of health.env) {
      console.log(`  ${pad(fact.name)}: ${fact.value ? pc.green(fact.value) : pc.dim("not set")}`);
    }
  }
  console.log(
    `  ${pad("$MU_SESSION")}: ${process.env.MU_SESSION ? pc.green(process.env.MU_SESSION) : pc.dim("not set")}`,
  );

  // ─ DB + schema
  console.log(pc.bold("\ndb"));
  console.log(`  path             : ${pc.dim(defaultDbPath())}`);
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length === 0) {
      console.log(`  schema           : ${pc.green("ok")} (${EXPECTED_TABLES.length} tables)`);
    } else {
      console.log(`  schema           : ${pc.red("missing")} — ${missing.join(", ")}`);
    }
    // Schema version: should match CURRENT_SCHEMA_VERSION after openDb
    // (which runs migrations). Mismatch means either a downgrade
    // attempt or a bug in the migration runner — either way, surface it.
    try {
      const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        | { version: number }
        | undefined;
      const v = row?.version;
      if (v === undefined) {
        console.log(
          `  schema_version   : ${pc.red("missing row")} (expected ${CURRENT_SCHEMA_VERSION})`,
        );
      } else if (v === CURRENT_SCHEMA_VERSION) {
        console.log(`  schema_version   : ${pc.green(String(v))}`);
      } else if (v < CURRENT_SCHEMA_VERSION) {
        console.log(
          `  schema_version   : ${pc.yellow(String(v))} (code expects ${CURRENT_SCHEMA_VERSION}; openDb should have migrated)`,
        );
      } else {
        console.log(
          `  schema_version   : ${pc.red(String(v))} (code expects ${CURRENT_SCHEMA_VERSION}; possible downgrade or future-version DB)`,
        );
      }
    } catch {
      console.log(
        `  schema_version   : ${pc.red("unreadable")} (schema_version table missing or wrong shape)`,
      );
    }
    const journal = db.pragma("journal_mode", { simple: true });
    console.log(
      `  journal_mode     : ${journal === "wal" ? pc.green(String(journal)) : pc.yellow(String(journal))}`,
    );
    const fk = db.pragma("foreign_keys", { simple: true });
    console.log(`  foreign_keys     : ${fk === 1 ? pc.green("on") : pc.red(`off (${fk})`)}`);
  } catch (err) {
    console.log(
      `  schema           : ${pc.red("FAIL")} — ${err instanceof Error ? err.message : err}`,
    );
  }

  // ─ Workstream auto-detect
  console.log(pc.bold("\nworkstream"));
  let currentWorkstream: string | null = null;
  try {
    currentWorkstream = await resolveWorkstream();
    console.log(`  current          : ${pc.green(currentWorkstream)}`);
  } catch {
    console.log(
      `  current          : ${pc.yellow("none")} (set $MU_SESSION, cd into an mu-<name> mux session, or pass -w to a subcommand)`,
    );
  }

  // ─ Per-workstream stats (current only; --all stretch)
  if (currentWorkstream) {
    const ws = currentWorkstream;
    console.log(pc.bold(`\nstate (workstream=${ws})`));
    const summary = await summarizeWorkstream(db, { workstream: ws });
    const counts = {
      agents: summary.agentCount,
      tasks: summary.taskCount,
      ready: countReady(db, ws),
      blocked: countBlocked(db, ws),
      inProgress: countInProgressByWorkstream(db, ws),
      logs: countLogsByWorkstream(db, ws),
    };
    console.log(`  agents           : ${counts.agents}`);
    console.log(
      `  tasks            : ${counts.tasks} (ready ${counts.ready}, blocked ${counts.blocked}, in-progress ${counts.inProgress})`,
    );
    console.log(`  ops rows         : ${counts.logs}`);

    // Reconciliation: ghost detection (DB rows with dead panes) + orphans.
    // mu doctor is diagnostic — mode: "report-only" so it never
    // deletes rows AND never writes to the DB / tmux titles just for
    // being polled (would race in-flight spawns; see
    // bug_agent_spawn_workspace_fk_failure).
    try {
      const view = await listLiveAgents(db, { workstream: ws, mode: "report-only" });
      const ghosts = view.report.prunedGhosts;
      const ghostNote =
        ghosts > 0
          ? pc.yellow(
              `${ghosts} ghost pane${ghosts === 1 ? "" : "s"} would be reaped by \`mu state\` or \`mu agent list\``,
            )
          : pc.green("none");
      console.log(`  ghosts           : ${ghostNote}`);
      const orphanColor = view.orphans.length > 0 ? pc.yellow : pc.green;
      console.log(
        `  orphan panes     : ${orphanColor(String(view.orphans.length))}${view.orphans.length > 0 ? pc.dim(" (run `mu agent list` to see them)") : ""}`,
      );
    } catch (err) {
      console.log(
        `  reconcile        : ${pc.dim("skipped")} (${err instanceof Error ? err.message : err})`,
      );
    }
  }

  // ─ Mixed-fleet hazards (cheap: two path compares, one statfs, one scan)
  //
  // These run in the DEFAULT doctor because they are cheap AND
  // PREVENTABLE — each one is a condition the operator can fix before it
  // costs them data, unlike drift which is a bug report.
  console.log(pc.bold("\nfleet"));
  let sawHazard = printHazards(checkFleetHazards(db, { dbPath: defaultDbPath() }));

  // ─ Disk ↔ DB reconciliation
  //
  // The only section that reads the filesystem. Default tier is readdir
  // + stat (~1ms); recursive byte accounting is --disk, because its cost
  // scales with the checkouts rather than with mu's state.
  console.log(pc.bold("\ndisk"));
  if (printHazards(checkDiskRecon(db))) sawHazard = true;
  if (opts.disk === true) {
    const usage = measureWorkspaceUsage(db);
    const total = usage.reduce((n, u) => n + u.bytes, 0);
    const reclaimable = usage.filter((u) => u.orphan).reduce((n, u) => n + u.bytes, 0);
    console.log(
      `\n  ${"workspace bytes".padEnd(16)} : ${formatBytes(total)} across ${usage.length} checkout(s)${
        reclaimable > 0 ? pc.yellow(` — ${formatBytes(reclaimable)} in orphan dirs`) : ""
      }`,
    );
    for (const u of usage) {
      const tag = u.orphan ? pc.yellow(" orphan") : "";
      console.log(
        `      ${formatBytes(u.bytes).padStart(6)}  ${u.workstreamName}/${u.agentName}${tag}`,
      );
    }
  } else {
    console.log(
      pc.dim("  (run `mu doctor --disk` for per-workspace byte usage — walks every checkout)"),
    );
  }

  // ─ Ops-log drift
  //
  // TIERED ON PURPOSE. The full rebuild-and-diff is ~0.6ms per op
  // (measured: 2.2s on a 1000-task / 3461-op DB), which is too slow to
  // put in a reflexively-run command. So the default runs a ~1ms
  // invariant and points at --deep; --deep runs the real thing.
  console.log(pc.bold("\nops log"));
  if (opts.deep === true) {
    const report = checkDrift(db);
    const compared = Object.entries(report.rowsCompared)
      .map(([t, n]) => `${n} ${t}`)
      .join(", ");
    if (report.clean) {
      console.log(
        `  drift            : ${pc.green("ok")} ${pc.dim(`rebuild matches live tables (${compared}, ${report.elapsedMs}ms)`)}`,
      );
    } else {
      console.log(
        `  drift            : ${pc.red("FAIL")} ${report.totalDrift} divergence(s) ${pc.dim(`(${report.elapsedMs}ms)`)}`,
      );
      for (const record of report.records) console.log(`      ${formatDriftRecord(record)}`);
      if (report.totalDrift > report.records.length) {
        console.log(pc.dim(`      … and ${report.totalDrift - report.records.length} more`));
      }
      console.log("");
      for (const line of driftRemediation()) console.log(`  ${line}`);
      // Non-zero exit so CI and wrapper scripts notice. Thrown last so
      // the whole report is printed first.
      throw new DriftDetectedError(report.totalDrift, report.records);
    }
  } else {
    const cheap = checkCheapDriftInvariant(db);
    if (cheap.clean) {
      console.log(
        `  drift (shallow)  : ${pc.green("ok")} ${pc.dim(`every live row has ops (${cheap.elapsedMs}ms) — run \`mu doctor --deep\` for the full rebuild diff`)}`,
      );
    } else {
      console.log(
        `  drift (shallow)  : ${pc.red("FAIL")} ${cheap.totalUnexplained} row(s) with NO ops explaining their existence`,
      );
      for (const row of cheap.unexplainedRows) {
        console.log(`      ${row.table} ${row.key}: no op names this key`);
      }
      console.log(pc.dim("      capture missed these rows entirely. Run `mu doctor --deep`."));
      console.log("");
      for (const line of driftRemediation()) console.log(`  ${line}`);
      throw new DriftDetectedError(cheap.totalUnexplained, []);
    }
  }
  if (sawHazard) {
    console.log(
      pc.dim("\nSee the fleet / disk sections above: at least one finding needs attention."),
    );
  }
}

/**
 * JSON form of `mu doctor`. Same checks the human form runs, collected
 * into a single structured record for piping. Surfaces 'ok' / 'warn' /
 * 'fail' for each subsystem so callers can match on a single field.
 */
export async function cmdDoctorJson(
  db: Db,
  opts: { deep?: boolean; disk?: boolean } = {},
): Promise<void> {
  // environment
  const health = await muxHealth();
  const env = {
    // `mux` is the backend-agnostic key. `tmux` is kept as an alias for
    // back-compat with scripts that grew around the pre-MuxBackend
    // shape; it reports the ACTIVE backend, whatever it is.
    mux: health ?? { name: null, ok: false, version: null },
    tmux: { ok: health?.ok ?? false, version: health?.version ?? null },
    ...Object.fromEntries(health?.env.map((f) => [f.name.replace(/^\$/, ""), f.value]) ?? []),
    MU_SESSION: process.env.MU_SESSION ?? null,
  };

  // db / schema
  let dbReport: Record<string, unknown>;
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    let schemaVersion: number | null = null;
    let schemaVersionStatus: "ok" | "missing" | "stale" | "future" | "unreadable";
    try {
      const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        | { version: number }
        | undefined;
      const v = row?.version;
      if (v === undefined) schemaVersionStatus = "missing";
      else {
        schemaVersion = v;
        if (v === CURRENT_SCHEMA_VERSION) schemaVersionStatus = "ok";
        else if (v < CURRENT_SCHEMA_VERSION) schemaVersionStatus = "stale";
        else schemaVersionStatus = "future";
      }
    } catch {
      schemaVersionStatus = "unreadable";
    }
    const journal = db.pragma("journal_mode", { simple: true });
    const fk = db.pragma("foreign_keys", { simple: true });
    dbReport = {
      path: defaultDbPath(),
      schema: { ok: missing.length === 0, expected: EXPECTED_TABLES, missing, present: tables },
      schemaVersion: {
        value: schemaVersion,
        expected: CURRENT_SCHEMA_VERSION,
        status: schemaVersionStatus,
      },
      journalMode: journal,
      foreignKeys: fk === 1,
    };
  } catch (err) {
    dbReport = { error: err instanceof Error ? err.message : String(err) };
  }

  // workstream
  let currentWorkstream: string | null = null;
  try {
    currentWorkstream = await resolveWorkstream();
  } catch {
    currentWorkstream = null;
  }

  // per-workstream stats (only when resolvable)
  let workstreamStats: Record<string, unknown> | null = null;
  if (currentWorkstream) {
    const ws = currentWorkstream;
    const summary = await summarizeWorkstream(db, { workstream: ws });
    const counts = {
      agents: summary.agentCount,
      tasks: summary.taskCount,
      ready: countReady(db, ws),
      blocked: countBlocked(db, ws),
      inProgress: countInProgressByWorkstream(db, ws),
      logs: countLogsByWorkstream(db, ws),
    };
    let reconcile: Record<string, unknown> | null = null;
    try {
      // mu doctor --json: report-only for the same reason as the human path.
      const view = await listLiveAgents(db, { workstream: ws, mode: "report-only" });
      reconcile = {
        prunedGhosts: view.report.prunedGhosts,
        orphanCount: view.orphans.length,
      };
    } catch (err) {
      reconcile = { skipped: true, reason: err instanceof Error ? err.message : String(err) };
    }
    workstreamStats = { workstreamName: ws, ...counts, reconcile };
  }

  // Mixed-fleet hazards: same three checks the human path runs.
  const hazards = checkFleetHazards(db, { dbPath: defaultDbPath() }).map((h) => ({
    name: h.name,
    severity: h.severity,
    detail: h.detail,
  }));

  // Disk ↔ DB: same checks as the human path. Remediation lines ride
  // along here (unlike `fleet`, which drops them) because the whole
  // point of the section is that an agent reading --json can act on it.
  const disk = checkDiskRecon(db).map((h) => ({
    name: h.name,
    severity: h.severity,
    detail: h.detail,
    remediation: h.remediation ?? [],
  }));
  const workspaceUsage = opts.disk === true ? measureWorkspaceUsage(db) : null;

  // Drift: shallow by default, full rebuild diff under --deep. Same
  // tiering as the human path, for the same measured reason.
  let drift: Record<string, unknown>;
  let driftFailure: DriftDetectedError | null = null;
  if (opts.deep === true) {
    const report = checkDrift(db);
    drift = {
      mode: "deep",
      ok: report.clean,
      totalDrift: report.totalDrift,
      records: report.records,
      rowsCompared: report.rowsCompared,
      elapsedMs: report.elapsedMs,
    };
    if (!report.clean) driftFailure = new DriftDetectedError(report.totalDrift, report.records);
  } else {
    const cheap = checkCheapDriftInvariant(db);
    drift = {
      mode: "shallow",
      ok: cheap.clean,
      totalUnexplained: cheap.totalUnexplained,
      unexplainedRows: cheap.unexplainedRows,
      elapsedMs: cheap.elapsedMs,
      hint: "run `mu doctor --deep --json` for the full rebuild diff",
    };
    if (!cheap.clean) driftFailure = new DriftDetectedError(cheap.totalUnexplained, []);
  }

  emitJson({
    environment: env,
    db: dbReport,
    workstream: { currentName: currentWorkstream },
    state: workstreamStats,
    fleet: hazards,
    disk,
    workspaceUsage,
    drift,
    remediation: drift.ok === true ? [] : driftRemediation(),
  });
  // Emit the payload FIRST, then fail: a --json consumer needs the
  // machine-readable report even when the exit code is non-zero.
  if (driftFailure !== null) throw driftFailure;
}

// agents/tasks counts come from summarizeWorkstream() (src/workstream.ts) —
// it already runs the same JOIN-on-workstreams SELECTs for its summary, so
// we don't keep a second copy of those queries here. The four helpers below
// (in-progress / logs / ready / blocked) are doctor-only views that
// summarizeWorkstream doesn't expose.
function countInProgressByWorkstream(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE ws.name = ? AND t.status = 'IN_PROGRESS'`,
      )
      .get(workstream) as { n: number }
  ).n;
}
function countLogsByWorkstream(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        // ops.key is the natural key ('' = machine-wide), so no join.
        "SELECT COUNT(*) AS n FROM ops WHERE key = ?",
      )
      .get(workstream) as { n: number }
  ).n;
}
function countReady(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ready v
           JOIN workstreams ws ON ws.id = v.workstream_id
          WHERE ws.name = ?`,
      )
      .get(workstream) as { n: number }
  ).n;
}
function countBlocked(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM blocked v
           JOIN workstreams ws ON ws.id = v.workstream_id
          WHERE ws.name = ?`,
      )
      .get(workstream) as { n: number }
  ).n;
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireDoctorCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { handle, JSON_OPT } from "../cli.js";

export function wireDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Environment + state health check")
    .option(...JSON_OPT)
    .option(
      "--deep",
      "also rebuild the ops log into a temp DB and diff it against the live tables (slower: ~0.6ms per op)",
    )
    .option(
      "--disk",
      "also measure per-workspace disk usage (walks every checkout; the disk↔DB reconciliation itself always runs)",
    )
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean; deep?: boolean; disk?: boolean };
      return handle((db) => cmdDoctor(db, opts), this as Command)();
    });
}
