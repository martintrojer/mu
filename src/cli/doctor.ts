// mu — `mu doctor` diagnostic verb (human + --json forms).
//
// Reports:
//   - environment: tmux, $TMUX, $TMUX_PANE, $MU_SESSION
//   - db: schema integrity, schema_version, journal_mode, foreign_keys
//   - workstream: auto-detected current workstream
//   - state: per-workstream agent / task / log counts + reconcile drift
//
// Read-only (the reconcile pass uses mode: "report-only" so polling doesn't
// race in-flight spawns; see bug_agent_spawn_workspace_fk_failure).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { listLiveAgents } from "../agents.js";
import { emitJson, resolveWorkstream } from "../cli.js";
import { CURRENT_SCHEMA_VERSION, type Db, EXPECTED_TABLES, defaultDbPath } from "../db.js";
import { pc } from "../output.js";
import { tmux } from "../tmux.js";
import { summarizeWorkstream } from "../workstream.js";

export async function cmdDoctor(db: Db, opts: { json?: boolean } = {}): Promise<void> {
  if (opts.json) {
    return cmdDoctorJson(db);
  }
  console.log(pc.bold("mu doctor"));

  // ─ Environment
  console.log(pc.bold("\nenvironment"));
  try {
    const version = (await tmux(["-V"])).trim();
    console.log(`  tmux             : ${pc.green("ok")} (${version})`);
  } catch {
    console.log(`  tmux             : ${pc.red("NOT FOUND")} — install tmux ≥ 3.0`);
  }
  console.log(`  $TMUX            : ${process.env.TMUX ? pc.green("set") : pc.yellow("not set")}`);
  console.log(
    `  $TMUX_PANE       : ${process.env.TMUX_PANE ? pc.green(process.env.TMUX_PANE) : pc.dim("not set")}`,
  );
  console.log(
    `  $MU_SESSION      : ${process.env.MU_SESSION ? pc.green(process.env.MU_SESSION) : pc.dim("not set")}`,
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
      `  current          : ${pc.yellow("none")} (set $MU_SESSION, cd into an mu-<name> tmux session, or pass -w to a subcommand)`,
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
    console.log(`  agent_logs rows  : ${counts.logs}`);

    // Reconciliation: ghost detection (DB rows with dead panes) + orphans.
    // mu doctor is diagnostic — mode: "report-only" so it never
    // deletes rows AND never writes to the DB / tmux titles just for
    // being polled (would race in-flight spawns; see
    // bug_agent_spawn_workspace_fk_failure).
    try {
      const view = await listLiveAgents(db, { workstream: ws, mode: "report-only" });
      const ghostNote =
        view.report.prunedGhosts > 0
          ? pc.yellow(`pruned ${view.report.prunedGhosts} during this check`)
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
}

/**
 * JSON form of `mu doctor`. Same checks the human form runs, collected
 * into a single structured record for piping. Surfaces 'ok' / 'warn' /
 * 'fail' for each subsystem so callers can match on a single field.
 */
export async function cmdDoctorJson(db: Db): Promise<void> {
  // environment
  let tmuxVersion: string | null = null;
  let tmuxOk = false;
  try {
    tmuxVersion = (await tmux(["-V"])).trim();
    tmuxOk = true;
  } catch {
    tmuxOk = false;
  }
  const env = {
    tmux: { ok: tmuxOk, version: tmuxVersion },
    TMUX: process.env.TMUX ?? null,
    TMUX_PANE: process.env.TMUX_PANE ?? null,
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

  emitJson({
    environment: env,
    db: dbReport,
    workstream: { currentName: currentWorkstream },
    state: workstreamStats,
  });
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
        `SELECT COUNT(*) AS n FROM agent_logs l
           LEFT JOIN workstreams ws ON ws.id = l.workstream_id
          WHERE ws.name = ?`,
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
import { JSON_OPT, handle } from "../cli.js";

export function wireDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Environment + state health check")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdDoctor(db, opts))();
    });
}
