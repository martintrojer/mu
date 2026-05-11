// Tests for the `mu undo`, `mu snapshot list`, `mu snapshot show` CLI
// verbs (snap_undo_verb).
//
// Drives buildProgram() in-process via runCli() so we exercise the same
// code path the shell user sees, but without spawning subprocesses.
//
// Coverage:
//   - mu undo with no snapshots → friendly message + nextSteps; exit 0.
//   - mu undo --to <bad-id> → SnapshotNotFoundError, exit 3.
//   - mu undo (no --yes) → dry-run; nothing changed.
//   - mu undo --yes → restores, task close design rolls back.
//   - mu undo --yes a second time → rolls forward (undo of undo).
//   - mu snapshot list shape (empty + populated, --json + table).
//   - mu snapshot show <id> shape + missing-id error.
//
// The reconcile path inside cmdUndo iterates workstreams and shells out
// to tmux. The runCli harness doesn't run a tmux server, so reconcile
// per-workstream may throw — cmdUndo catches that per-workstream and
// continues (best-effort), so undo --yes still completes cleanly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { captureSnapshot, listSnapshots } from "../src/snapshots.js";
import { addTask, closeTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-cli-snap-"));
  // Set MU_STATE_DIR so snapshots land in the temp dir, not
  // ~/.local/state/mu/. The runCli helper sets MU_DB_PATH for us;
  // we additionally need MU_STATE_DIR to keep snapshotsDir() (which
  // falls back when no Db handle is passed) on the temp dir too.
  process.env.MU_STATE_DIR = tempDir;
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  addTask(db, {
    localId: "design",
    workstream: "auth",
    title: "Design",
    impact: 80,
    effortDays: 1,
  });
  addTask(db, {
    localId: "build",
    workstream: "auth",
    title: "Build",
    impact: 80,
    effortDays: 2,
    blockedBy: ["design"],
  });
  db.close();
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

// ─── mu undo ─────────────────────────────────────────────────────

describe("mu undo", () => {
  it("with no snapshots prints a friendly message and exits 0", async () => {
    const { stdout, exitCode, error } = await runCli(["undo"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stdout).toContain("no snapshots to undo");
  });

  it("--json with no snapshots emits structured nothing-to-do shape", async () => {
    const { stdout, exitCode, error } = await runCli(["undo", "--json"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as { restored: boolean; reason: string };
    expect(parsed.restored).toBe(false);
    expect(parsed.reason).toBe("no snapshots");
  });

  it("--to <bad-id> errors with SnapshotNotFoundError; exit 3", async () => {
    const { stderr, exitCode } = await runCli(["undo", "--to", "9999"], dbPath);
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such snapshot/i);
  });

  it("--to <bad-id> --json emits a typed error envelope and exits 3", async () => {
    // runCli() now mirrors argv onto process.argv so isJsonMode() picks
    // up --json. Pin the JSON-error envelope shape (error name + exit
    // code + missing-id mention) — without this assertion a regression
    // in emitError's JSON shape would only break in production.
    const { stderr, exitCode } = await runCli(["undo", "--to", "9999", "--json"], dbPath);
    expect(exitCode).toBe(3);
    const lines = stderr.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBeDefined();
    const envelope = JSON.parse(lastLine as string) as {
      error: string;
      message: string;
      exitCode: number;
      nextSteps?: { intent: string; command: string }[];
    };
    expect(envelope.error).toBe("SnapshotNotFoundError");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.message).toMatch(/no such snapshot/i);
    expect(envelope.message).toContain("9999");
  });

  it("without --yes is a dry-run; no rows change", async () => {
    // Seed: take a real snapshot via closeTask.
    db = openDb({ path: dbPath });
    closeTask(db, "design", { workstream: "auth" });
    const beforeStatus = getTask(db, "design", "auth")?.status;
    db.close();
    expect(beforeStatus).toBe("CLOSED");

    const { stdout, exitCode, error } = await runCli(["undo"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stdout).toContain("About to restore snapshot");
    expect(stdout).toContain("dry-run");

    // Status unchanged.
    db = openDb({ path: dbPath });
    expect(getTask(db, "design", "auth")?.status).toBe("CLOSED");
    db.close();
  });

  it("--yes round-trips a task close (CLOSED → OPEN)", async () => {
    db = openDb({ path: dbPath });
    closeTask(db, "design", { workstream: "auth" });
    db.close();

    const { stdout, exitCode, error } = await runCli(["undo", "--yes"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stdout).toContain("Restored snapshot");
    // The reconcile pass now runs in dryRun mode (snap_undo_reconcile_destroys_recovered_agents)
    // so the heading reflects "rows NOT pruned" too.
    expect(stdout).toContain("Reconcile (tmux NOT rolled back; rows NOT pruned)");

    db = openDb({ path: dbPath });
    expect(getTask(db, "design", "auth")?.status).toBe("OPEN");
    // Pre-restore snapshot is in the table so a second `mu undo` rolls
    // forward (snap_design §EDGE CASES > snapshot-of-snapshot).
    const snaps = listSnapshots(db);
    expect(snaps.some((r) => r.label.startsWith("pre-restore"))).toBe(true);
    db.close();
  });

  it("--yes a second time rolls forward (undo of undo)", async () => {
    db = openDb({ path: dbPath });
    closeTask(db, "design", { workstream: "auth" });
    db.close();

    // First undo: CLOSED → OPEN.
    await runCli(["undo", "--yes"], dbPath);
    db = openDb({ path: dbPath });
    expect(getTask(db, "design", "auth")?.status).toBe("OPEN");
    db.close();

    // Second undo restores the pre-restore snapshot, which is the
    // post-close state: design is CLOSED again.
    const { error } = await runCli(["undo", "--yes"], dbPath);
    expect(error).toBeUndefined();
    db = openDb({ path: dbPath });
    expect(getTask(db, "design", "auth")?.status).toBe("CLOSED");
    db.close();
  });

  it("--yes --json emits the restored shape with reconcile counts", async () => {
    db = openDb({ path: dbPath });
    closeTask(db, "design", { workstream: "auth" });
    db.close();

    const { stdout, exitCode, error } = await runCli(["undo", "--yes", "--json"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as {
      restored: boolean;
      snapshot: { id: number; label: string };
      restoredTo: string;
      schemaVersion: number;
      reconcile: {
        wouldBePrunedGhosts: number;
        orphansSurfaced: number;
        mode: string;
      };
    };
    expect(parsed.restored).toBe(true);
    expect(parsed.snapshot.label).toBe("task close design");
    expect(parsed.restoredTo).toBe(dbPath);
    expect(typeof parsed.schemaVersion).toBe("number");
    // Field rename: ghostsPruned → wouldBePrunedGhosts (the post-restore
    // reconcile is now dry-run by default to honour the
    // "restore brings back snapshot rows verbatim" contract —
    // snap_undo_reconcile_destroys_recovered_agents).
    expect(parsed.reconcile.wouldBePrunedGhosts).toBeGreaterThanOrEqual(0);
    expect(parsed.reconcile.mode).toBe("report-only");
  });
});

// ─── mu snapshot list ────────────────────────────────────────────

describe("mu snapshot list", () => {
  it("empty table prints a friendly message", async () => {
    const { stdout, exitCode, error } = await runCli(["snapshot", "list"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stdout).toContain("no snapshots");
  });

  it("--json with no snapshots emits an empty collection envelope", async () => {
    const { stdout, error } = await runCli(["snapshot", "list", "--json"], dbPath);
    expect(error).toBeUndefined();
    expect(JSON.parse(stdout.trim())).toEqual({ items: [], count: 0 });
  });

  it("populated --json emits an array of rows with sizeBytes", async () => {
    db = openDb({ path: dbPath });
    captureSnapshot(db, "snap-a", "auth");
    captureSnapshot(db, "snap-b", "auth");
    captureSnapshot(db, "snap-c", null);
    db.close();

    const { stdout, error } = await runCli(["snapshot", "list", "--json"], dbPath);
    expect(error).toBeUndefined();
    const env = JSON.parse(stdout.trim()) as {
      items: Array<{
        id: number;
        label: string;
        workstreamName: string | null;
        sizeBytes: number | null;
      }>;
      count: number;
    };
    // Newest first (id DESC).
    expect(env.items.map((r) => r.label)).toEqual(["snap-c", "snap-b", "snap-a"]);
    expect(env.items[0]?.workstreamName).toBeNull();
    expect(env.items[0]?.sizeBytes).toBeGreaterThan(0);
    expect(env.count).toBe(3);
  });

  it("populated table form contains every label and the workstream", async () => {
    db = openDb({ path: dbPath });
    captureSnapshot(db, "snap-a", "auth");
    captureSnapshot(db, "snap-b", null);
    db.close();

    const { stdout, error } = await runCli(["snapshot", "list"], dbPath);
    expect(error).toBeUndefined();
    expect(stdout).toContain("snap-a");
    expect(stdout).toContain("snap-b");
    expect(stdout).toContain("auth");
    // <whole-DB> dim label for the null-workstream row.
    expect(stdout).toContain("whole-DB");
  });

  it("-n caps the row count", async () => {
    db = openDb({ path: dbPath });
    for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
    db.close();

    const { stdout, error } = await runCli(["snapshot", "list", "-n", "2", "--json"], dbPath);
    expect(error).toBeUndefined();
    const env = JSON.parse(stdout.trim()) as { items: Array<{ label: string }>; count: number };
    expect(env.items.length).toBe(2);
    expect(env.count).toBe(2);
  });
});

// ─── mu snapshot show ────────────────────────────────────────────

describe("mu snapshot show", () => {
  it("missing id errors with SnapshotNotFoundError; exit 3", async () => {
    const { stderr, exitCode } = await runCli(["snapshot", "show", "999"], dbPath);
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such snapshot/i);
  });

  it("happy path prints all 6 metadata lines", async () => {
    db = openDb({ path: dbPath });
    const snap = captureSnapshot(db, "task close design", "auth");
    db.close();

    const { stdout, exitCode, error } = await runCli(["snapshot", "show", String(snap.id)], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stdout).toContain(`snapshot #${snap.id}`);
    expect(stdout).toContain("label");
    expect(stdout).toContain("task close design");
    expect(stdout).toContain("workstream");
    expect(stdout).toContain("auth");
    expect(stdout).toContain("schema_version");
    expect(stdout).toContain("db_path");
    expect(stdout).toContain("size");
    expect(stdout).toContain("created_at");
  });

  it("--json emits the full row + sizeBytes", async () => {
    db = openDb({ path: dbPath });
    const snap = captureSnapshot(db, "task close design", "auth");
    db.close();

    const { stdout, error } = await runCli(["snapshot", "show", String(snap.id), "--json"], dbPath);
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as {
      id: number;
      label: string;
      workstreamName: string;
      schemaVersion: number;
      dbPath: string;
      sizeBytes: number;
      createdAt: string;
    };
    expect(parsed.id).toBe(snap.id);
    expect(parsed.label).toBe("task close design");
    expect(parsed.workstreamName).toBe("auth");
    // v7 is the current schema (v5 → v6 added archive_* tables;
    // v6 → v7 dropped the approvals table); pre-v5 versions are
    // rejected at openDb.
    expect(parsed.schemaVersion).toBe(7);
    expect(parsed.sizeBytes).toBeGreaterThan(0);
  });
});

// ─── snapshot_gc_caps_too_lax_no_cleanup_verb: prune + delete CLI ──

import { CURRENT_SCHEMA_VERSION as CSV } from "../src/db.js";

/** Strip ANSI escape sequences for substring assertions. */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI by definition
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("mu snapshot prune", () => {
  it("bare form: dry-run summary; nothing changes", async () => {
    db = openDb({ path: dbPath });
    captureSnapshot(db, "a", "auth");
    captureSnapshot(db, "b", "auth");
    const before = listSnapshots(db).length;
    db.close();
    const { stdout, error } = await runCli(["snapshot", "prune"], dbPath);
    expect(error).toBeUndefined();
    expect(stdout).toContain("Would delete");
    expect(stdout).toContain("dry-run");
    db = openDb({ path: dbPath });
    expect(listSnapshots(db).length).toBe(before);
    db.close();
  });

  it("--keep-last N --yes deletes everything except the N newest", async () => {
    db = openDb({ path: dbPath });
    for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
    db.close();
    const { stdout, error } = await runCli(
      ["snapshot", "prune", "--keep-last", "2", "--yes"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stdout).toContain("Deleted");
    db = openDb({ path: dbPath });
    expect(listSnapshots(db).length).toBe(2);
    db.close();
  });

  it("--keep-last --json (dry-run) emits wouldDelete shape", async () => {
    db = openDb({ path: dbPath });
    for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
    db.close();
    const { stdout, error } = await runCli(
      ["snapshot", "prune", "--keep-last", "2", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as {
      dryRun: boolean;
      mode: string;
      wouldDeleteRows: number;
      wouldFreeBytes: number;
      victims: unknown[];
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.mode).toBe("keep-last");
    expect(parsed.wouldDeleteRows).toBe(3);
    expect(parsed.wouldFreeBytes).toBeGreaterThan(0);
    expect(parsed.victims.length).toBe(3);
  });

  it("--older-than 7d deletes rows older than 7 days", async () => {
    db = openDb({ path: dbPath });
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 3; i++) stmt.run("auth", `o${i}`, `/x/o${i}.db`, CSV, old);
    for (let i = 0; i < 2; i++) stmt.run("auth", `f${i}`, `/x/f${i}.db`, CSV, fresh);
    db.close();
    const { stdout, error } = await runCli(
      ["snapshot", "prune", "--older-than", "7d", "--yes"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stdout).toContain("Deleted");
    db = openDb({ path: dbPath });
    const labels = listSnapshots(db).map((r) => r.label);
    expect(labels).toEqual(["f1", "f0"]);
    db.close();
  });

  it("--older-than rejects malformed values", async () => {
    const { exitCode } = await runCli(["snapshot", "prune", "--older-than", "garbage"], dbPath);
    // The custom parser throws inside commander's option-handling,
    // which produces a non-zero exit (commander's invalidArgument
    // CommanderError). The exact code is commander-internal; we only
    // pin that the verb did not silently succeed.
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBeNull();
  });

  it("--stale-version drops only schema_version != current rows", async () => {
    db = openDb({ path: dbPath });
    const a = captureSnapshot(db, "fresh-1", "auth");
    const b = captureSnapshot(db, "stale", "auth");
    db.prepare("UPDATE snapshots SET schema_version = ? WHERE id = ?").run(CSV - 1, b.id);
    db.close();
    const { stdout, error } = await runCli(
      ["snapshot", "prune", "--stale-version", "--yes", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as {
      deletedRows: number;
      freedBytes: number;
    };
    expect(parsed.deletedRows).toBe(1);
    db = openDb({ path: dbPath });
    expect(listSnapshots(db).map((r) => r.id)).toEqual([a.id]);
    db.close();
  });

  it("--all --yes deletes everything BUT the safety-net snapshot remains", async () => {
    db = openDb({ path: dbPath });
    for (let i = 0; i < 3; i++) captureSnapshot(db, `s${i}`, "auth");
    db.close();
    const { stdout, error } = await runCli(
      ["snapshot", "prune", "--all", "--yes", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as {
      deletedRows: number;
      safetyNetSnapshotId?: number;
    };
    expect(parsed.deletedRows).toBe(3);
    expect(parsed.safetyNetSnapshotId).toBeDefined();
    db = openDb({ path: dbPath });
    const remaining = listSnapshots(db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.label).toMatch(/safety-net/);
    expect(remaining[0]?.id).toBe(parsed.safetyNetSnapshotId);
    db.close();
  });

  it("--all (no --yes) is dry-run; safety-net is NOT taken yet", async () => {
    db = openDb({ path: dbPath });
    for (let i = 0; i < 3; i++) captureSnapshot(db, `s${i}`, "auth");
    const before = listSnapshots(db).length;
    db.close();
    const { stdout, error } = await runCli(["snapshot", "prune", "--all"], dbPath);
    expect(error).toBeUndefined();
    expect(stdout).toContain("Would delete");
    db = openDb({ path: dbPath });
    expect(listSnapshots(db).length).toBe(before);
    db.close();
  });

  it("rejects mutually-exclusive flags with UsageError exit 2", async () => {
    const { exitCode, stderr } = await runCli(
      ["snapshot", "prune", "--all", "--keep-last", "1"],
      dbPath,
    );
    // UsageError maps to exit 2 (commander's usage-error code).
    expect(exitCode).toBe(2);
    expect(stderr.toLowerCase()).toContain("mutually exclusive");
  });
});

describe("mu snapshot delete <id>", () => {
  it("removes the row + the on-disk .db file; emits success message", async () => {
    db = openDb({ path: dbPath });
    const snap = captureSnapshot(db, "a", "auth");
    db.close();
    const { stdout, error } = await runCli(["snapshot", "delete", String(snap.id)], dbPath);
    expect(error).toBeUndefined();
    // Strip ANSI for substring assertion (pc.bold wraps the #N).
    const plain = stripAnsi(stdout);
    expect(plain).toContain(`Deleted snapshot #${snap.id}`);
    db = openDb({ path: dbPath });
    expect(listSnapshots(db).find((r) => r.id === snap.id)).toBeUndefined();
    db.close();
  });

  it("missing id errors with SnapshotNotFoundError; exit 3", async () => {
    const { stderr, exitCode } = await runCli(["snapshot", "delete", "9999"], dbPath);
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such snapshot/i);
  });

  it("--json shape includes snapshotId, deleted, deletedFiles, freedBytes", async () => {
    db = openDb({ path: dbPath });
    const snap = captureSnapshot(db, "a", "auth");
    db.close();
    const { stdout, error } = await runCli(
      ["snapshot", "delete", String(snap.id), "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as {
      snapshotId: number;
      deleted: boolean;
      deletedFiles: number;
      freedBytes: number;
    };
    expect(parsed.snapshotId).toBe(snap.id);
    expect(parsed.deleted).toBe(true);
    expect(parsed.deletedFiles).toBe(1);
    expect(parsed.freedBytes).toBeGreaterThan(0);
  });

  it("does NOT auto-snapshot before the delete", async () => {
    db = openDb({ path: dbPath });
    const a = captureSnapshot(db, "a", "auth");
    const b = captureSnapshot(db, "b", "auth");
    db.close();
    await runCli(["snapshot", "delete", String(a.id)], dbPath);
    db = openDb({ path: dbPath });
    const after = listSnapshots(db);
    // Was 2 (a, b); deleted a; now 1 (b only). No new auto-snap row.
    expect(after.length).toBe(1);
    expect(after[0]?.id).toBe(b.id);
    db.close();
  });
});

// ─── snapshot list: schema_version column + dimming ──────────────

describe("mu snapshot list — schema_version column", () => {
  it("renders 'ver' column header alongside id and label", async () => {
    db = openDb({ path: dbPath });
    captureSnapshot(db, "a", "auth");
    db.close();
    const { stdout, error } = await runCli(["snapshot", "list"], dbPath);
    expect(error).toBeUndefined();
    // Strip ANSI codes (pc.bold wraps each header cell).
    const plain = stripAnsi(stdout);
    expect(plain).toMatch(/\bid\b/);
    expect(plain).toMatch(/\bver\b/);
    expect(plain).toMatch(/\blabel\b/);
    // Body row carries v<N> for the current schema.
    expect(plain).toContain(`v${CSV}`);
  });

  it("stale-version rows render with a Next: hint about pruning them", async () => {
    db = openDb({ path: dbPath });
    captureSnapshot(db, "fresh", "auth");
    const stale = captureSnapshot(db, "stale", "auth");
    db.prepare("UPDATE snapshots SET schema_version = ? WHERE id = ?").run(CSV - 1, stale.id);
    db.close();
    const { stdout, error } = await runCli(["snapshot", "list"], dbPath);
    expect(error).toBeUndefined();
    // The stale row's version stamp is rendered (v<N-1>).
    expect(stdout).toContain(`v${CSV - 1}`);
    // The Next: block grows a "Drop ... stale-version row" suggestion.
    expect(stdout).toMatch(/stale-version/i);
  });
});
