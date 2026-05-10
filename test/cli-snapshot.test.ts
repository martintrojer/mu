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

  it("--json with no snapshots emits []", async () => {
    const { stdout, error } = await runCli(["snapshot", "list", "--json"], dbPath);
    expect(error).toBeUndefined();
    expect(JSON.parse(stdout.trim())).toEqual([]);
  });

  it("populated --json emits an array of rows with sizeBytes", async () => {
    db = openDb({ path: dbPath });
    captureSnapshot(db, "snap-a", "auth");
    captureSnapshot(db, "snap-b", "auth");
    captureSnapshot(db, "snap-c", null);
    db.close();

    const { stdout, error } = await runCli(["snapshot", "list", "--json"], dbPath);
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as Array<{
      id: number;
      label: string;
      workstreamName: string | null;
      sizeBytes: number | null;
    }>;
    // Newest first (id DESC).
    expect(parsed.map((r) => r.label)).toEqual(["snap-c", "snap-b", "snap-a"]);
    expect(parsed[0]?.workstreamName).toBeNull();
    expect(parsed[0]?.sizeBytes).toBeGreaterThan(0);
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
    const parsed = JSON.parse(stdout.trim()) as Array<{ label: string }>;
    expect(parsed.length).toBe(2);
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
