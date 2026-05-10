// Tests for the `mu archive` CLI verbs (Phase 2 of the v0.3 archive
// feature). Drives buildProgram() in-process via runCli() so we
// exercise the same code path the shell user sees, without spawning
// subprocesses.
//
// Coverage map (mirrors the 7-case checklist in the
// archive_phase2_cli_verbs task design note):
//
//   1. create + list + show round-trip; verify JSON shape.
//   2. create with invalid label → ArchiveLabelInvalidError; exit 2.
//   3. create duplicate → ArchiveAlreadyExistsError; exit 4.
//   4. add + remove + show: per-source-ws counts.
//   5. add --destroy: workstream gone after add succeeds; archive intact.
//   6. add --destroy where archive doesn't exist: errors WITHOUT
//      destroying the workstream (atomicity invariant).
//   7. delete dry-run: archive still exists; delete --yes:
//      cascade-cleans every archived_* row + records snapshot.
//
// The runCli harness doesn't run a tmux server, so any verb that
// would shell out to tmux either has its own per-call try/catch
// (destroyWorkstream's killSession is best-effort against a missing
// session) or is skipped here. The DB-side assertions are what we
// care about.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listArchives } from "../src/archives.js";
import { type Db, openDb } from "../src/db.js";
import { listSnapshots } from "../src/snapshots.js";
import { addNote, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-archive-cli-"));
  // Snapshots dir defaults to <state-dir>/snapshots; pin to tempDir
  // so `mu archive delete --yes` doesn't pollute the host's state.
  process.env.MU_STATE_DIR = tempDir;
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  // Two workstreams with overlapping task names — the additive
  // accumulation pattern the archive feature is for.
  ensureWorkstream(db, "alpha");
  addTask(db, {
    localId: "design",
    workstream: "alpha",
    title: "Design alpha",
    impact: 80,
    effortDays: 1,
  });
  addTask(db, {
    localId: "build",
    workstream: "alpha",
    title: "Build alpha",
    impact: 80,
    effortDays: 2,
    blockedBy: ["design"],
  });
  addNote(db, "design", "design note", { workstream: "alpha", author: "user" });

  ensureWorkstream(db, "beta");
  addTask(db, {
    localId: "design",
    workstream: "beta",
    title: "Design beta",
    impact: 70,
    effortDays: 1,
  });
  db.close();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // best effort
  }
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

// ─── mu archive create / list / show round-trip ─────────────────────

describe("mu archive create / list / show", () => {
  it("create + list + show round-trip prints what we wrote (table)", async () => {
    const create = await runCli(
      ["archive", "create", "wave", "--description", "v0.3 cleanup"],
      dbPath,
    );
    expect(create.error).toBeUndefined();
    expect(create.exitCode).toBeNull();
    expect(create.stdout).toContain("Created archive");
    expect(create.stdout).toContain("wave");

    const list = await runCli(["archive", "list"], dbPath);
    expect(list.error).toBeUndefined();
    expect(list.stdout).toContain("wave");

    const show = await runCli(["archive", "show", "wave"], dbPath);
    expect(show.error).toBeUndefined();
    expect(show.stdout).toContain("archive wave");
    expect(show.stdout).toContain("v0.3 cleanup");
    expect(show.stdout).toContain("total_tasks    : 0");
  });

  it("create + list + show --json shape is well-formed", async () => {
    await runCli(["archive", "create", "wave"], dbPath);

    const create = await runCli(["archive", "create", "wave2", "--json"], dbPath);
    expect(create.error).toBeUndefined();
    const createObj = JSON.parse(create.stdout.trim()) as {
      archive: { label: string; createdAt: string; lastAddedAt: string };
      nextSteps: { intent: string; command: string }[];
    };
    expect(createObj.archive.label).toBe("wave2");
    expect(typeof createObj.archive.createdAt).toBe("string");
    expect(createObj.nextSteps.length).toBeGreaterThan(0);

    const list = await runCli(["archive", "list", "--json"], dbPath);
    const arr = JSON.parse(list.stdout.trim()) as Array<{
      label: string;
      totalTasks: number;
      sourceWorkstreams: unknown[];
    }>;
    expect(arr.map((r) => r.label).sort()).toEqual(["wave", "wave2"]);
    expect(arr[0]?.totalTasks).toBe(0);
    expect(arr[0]?.sourceWorkstreams).toEqual([]);

    const show = await runCli(["archive", "show", "wave", "--json"], dbPath);
    const obj = JSON.parse(show.stdout.trim()) as {
      label: string;
      totalTasks: number;
      sourceWorkstreams: unknown[];
    };
    expect(obj.label).toBe("wave");
    expect(obj.totalTasks).toBe(0);
  });

  it("list with no archives prints a friendly message", async () => {
    const { stdout, error } = await runCli(["archive", "list"], dbPath);
    expect(error).toBeUndefined();
    expect(stdout).toContain("(no archives)");
  });

  it("list with no archives --json emits []", async () => {
    const { stdout, error } = await runCli(["archive", "list", "--json"], dbPath);
    expect(error).toBeUndefined();
    expect(JSON.parse(stdout.trim())).toEqual([]);
  });
});

// ─── invalid label / duplicate label / not-found ────────────────────

describe("mu archive create error paths", () => {
  it("invalid label → ArchiveLabelInvalidError; exit 2", async () => {
    const { stderr, exitCode } = await runCli(["archive", "create", "Bad Label!"], dbPath);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/invalid archive label/i);
  });

  it("duplicate label → ArchiveAlreadyExistsError; exit 4", async () => {
    await runCli(["archive", "create", "wave"], dbPath);
    const { stderr, exitCode } = await runCli(["archive", "create", "wave"], dbPath);
    expect(exitCode).toBe(4);
    expect(stderr).toMatch(/already exists/i);
  });

  it("show missing archive → ArchiveNotFoundError; exit 3", async () => {
    const { stderr, exitCode } = await runCli(["archive", "show", "nope"], dbPath);
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such archive/i);
  });
});

// ─── add + remove + show: per-source-workstream counts ──────────────

describe("mu archive add / remove", () => {
  it("add + show: per-source-ws counts; remove leaves siblings intact", async () => {
    await runCli(["archive", "create", "wave"], dbPath);

    const addAlpha = await runCli(["archive", "add", "wave", "-w", "alpha", "--json"], dbPath);
    expect(addAlpha.error).toBeUndefined();
    const aResult = JSON.parse(addAlpha.stdout.trim()) as {
      archiveLabel: string;
      sourceWorkstream: string;
      addedTasks: number;
      addedNotes: number;
      destroyed: { ranDestroy: boolean };
    };
    expect(aResult.archiveLabel).toBe("wave");
    expect(aResult.sourceWorkstream).toBe("alpha");
    expect(aResult.addedTasks).toBe(2);
    expect(aResult.addedNotes).toBe(1);
    expect(aResult.destroyed.ranDestroy).toBe(false);

    const addBeta = await runCli(["archive", "add", "wave", "-w", "beta", "--json"], dbPath);
    expect(addBeta.error).toBeUndefined();
    const bResult = JSON.parse(addBeta.stdout.trim()) as { addedTasks: number };
    expect(bResult.addedTasks).toBe(1);

    const show = await runCli(["archive", "show", "wave", "--json"], dbPath);
    const summary = JSON.parse(show.stdout.trim()) as {
      totalTasks: number;
      sourceWorkstreams: { name: string; taskCount: number }[];
    };
    expect(summary.totalTasks).toBe(3);
    expect(summary.sourceWorkstreams.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);

    // Idempotency: re-running add against the same workstream is a
    // no-op for tasks already present.
    const reAdd = await runCli(["archive", "add", "wave", "-w", "alpha", "--json"], dbPath);
    const reResult = JSON.parse(reAdd.stdout.trim()) as {
      addedTasks: number;
      skippedTasks: number;
    };
    expect(reResult.addedTasks).toBe(0);
    expect(reResult.skippedTasks).toBe(2);

    // Surgical remove: alpha gone, beta intact.
    const remove = await runCli(["archive", "remove", "wave", "-w", "alpha", "--json"], dbPath);
    expect(remove.error).toBeUndefined();
    const rResult = JSON.parse(remove.stdout.trim()) as {
      removedTasks: number;
      removedNotes: number;
    };
    expect(rResult.removedTasks).toBe(2);
    expect(rResult.removedNotes).toBe(1);

    const showPost = await runCli(["archive", "show", "wave", "--json"], dbPath);
    const postSummary = JSON.parse(showPost.stdout.trim()) as {
      totalTasks: number;
      sourceWorkstreams: { name: string }[];
    };
    expect(postSummary.totalTasks).toBe(1);
    expect(postSummary.sourceWorkstreams.map((s) => s.name)).toEqual(["beta"]);
  });

  it("add against a missing archive → ArchiveNotFoundError; exit 3 (NO destroy side effect)", async () => {
    // Atomicity invariant: --destroy must NOT fire when the archive
    // precheck fails.
    const { stderr, exitCode } = await runCli(
      ["archive", "add", "no-such-archive", "-w", "alpha", "--destroy"],
      dbPath,
    );
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such archive/i);

    // alpha workstream still exists with both tasks.
    const ws = openDb({ path: dbPath });
    const tasks = ws
      .prepare(
        "SELECT t.local_id FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id WHERE ws.name = ?",
      )
      .all("alpha") as { local_id: string }[];
    expect(tasks.map((t) => t.local_id).sort()).toEqual(["build", "design"]);
    ws.close();
  });
});

// ─── add --destroy: cascade ─────────────────────────────────────────

describe("mu archive add --destroy", () => {
  it("after a successful add, the source workstream rows are gone; archive intact", async () => {
    await runCli(["archive", "create", "wave"], dbPath);

    const { error, stdout, exitCode } = await runCli(
      ["archive", "add", "wave", "-w", "alpha", "--destroy", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const result = JSON.parse(stdout.trim()) as {
      addedTasks: number;
      destroyed: { ranDestroy: boolean; deletedTasks?: number; deletedAgents?: number };
    };
    expect(result.addedTasks).toBe(2);
    expect(result.destroyed.ranDestroy).toBe(true);
    expect(result.destroyed.deletedTasks).toBe(2);

    // alpha workstream's live tasks are gone.
    const ws = openDb({ path: dbPath });
    const live = ws
      .prepare(
        "SELECT t.local_id FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id WHERE ws.name = ?",
      )
      .all("alpha") as { local_id: string }[];
    expect(live).toEqual([]);

    // Archive's snapshot of alpha is intact.
    const archived = ws
      .prepare(
        "SELECT original_local_id FROM archived_tasks t JOIN archives a ON a.id = t.archive_id WHERE a.label = ? AND t.source_workstream = ?",
      )
      .all("wave", "alpha") as { original_local_id: string }[];
    expect(archived.map((t) => t.original_local_id).sort()).toEqual(["build", "design"]);
    ws.close();
  });
});

// ─── delete: dry-run + --yes + snapshot ─────────────────────────────

describe("mu archive delete", () => {
  it("dry-run leaves the archive in place; --yes captures a snapshot then deletes", async () => {
    await runCli(["archive", "create", "wave"], dbPath);
    await runCli(["archive", "add", "wave", "-w", "alpha"], dbPath);

    const dry = await runCli(["archive", "delete", "wave"], dbPath);
    expect(dry.error).toBeUndefined();
    expect(dry.exitCode).toBeNull();
    expect(dry.stdout).toContain("dry-run");

    let post = openDb({ path: dbPath });
    expect(listArchives(post)).toHaveLength(1);
    expect(listSnapshots(post).filter((s) => s.label.startsWith("archive delete"))).toHaveLength(0);
    post.close();

    const real = await runCli(["archive", "delete", "wave", "--yes"], dbPath);
    expect(real.error).toBeUndefined();
    expect(real.exitCode).toBeNull();
    expect(real.stdout).toContain("Deleted archive");

    post = openDb({ path: dbPath });
    expect(listArchives(post)).toHaveLength(0);
    // Cascade cleaned every archived_* row.
    const archivedTasks = post.prepare("SELECT COUNT(*) AS n FROM archived_tasks").get() as {
      n: number;
    };
    expect(archivedTasks.n).toBe(0);
    // Pre-delete snapshot recorded.
    const snaps = listSnapshots(post);
    expect(snaps.some((s) => s.label === "archive delete wave")).toBe(true);
    post.close();
  });

  it("dry-run --json shape is { deleted: false, dryRun: true, summary }", async () => {
    await runCli(["archive", "create", "wave"], dbPath);
    const { stdout, error } = await runCli(["archive", "delete", "wave", "--json"], dbPath);
    expect(error).toBeUndefined();
    const obj = JSON.parse(stdout.trim()) as {
      archiveLabel: string;
      deleted: boolean;
      dryRun: boolean;
      summary: { label: string; totalTasks: number };
    };
    expect(obj.archiveLabel).toBe("wave");
    expect(obj.deleted).toBe(false);
    expect(obj.dryRun).toBe(true);
    expect(obj.summary.label).toBe("wave");
  });

  it("delete missing archive → ArchiveNotFoundError; exit 3 (also in dry-run mode)", async () => {
    const { stderr, exitCode } = await runCli(["archive", "delete", "ghost"], dbPath);
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such archive/i);
  });
});

// ─── mu workstream destroy --archive (Phase 3) ──────────────────
//
// Mirrors the `mu archive add --destroy` cascade but keyed off the
// destroy verb — the symmetric path for operators who reach for
// destroy first. Atomicity invariant: archive add runs BEFORE
// destroy, so a missing label refuses the destroy.

describe("mu workstream destroy --archive", () => {
  it("--archive <existing> --yes: workstream gone, archive grew", async () => {
    await runCli(["archive", "create", "wave"], dbPath);
    const { error, stdout, exitCode } = await runCli(
      ["workstream", "destroy", "-w", "alpha", "--archive", "wave", "--yes", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const obj = JSON.parse(stdout.trim()) as {
      destroyed: boolean;
      deletedTasks: number;
      archive?: { label: string; addedTasks: number };
    };
    expect(obj.destroyed).toBe(true);
    expect(obj.deletedTasks).toBe(2);
    expect(obj.archive).toMatchObject({ label: "wave", addedTasks: 2 });

    // alpha workstream's live tasks are gone.
    const post = openDb({ path: dbPath });
    const live = post
      .prepare(
        "SELECT t.local_id FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id WHERE ws.name = ?",
      )
      .all("alpha") as { local_id: string }[];
    expect(live).toEqual([]);
    // Archive grew: alpha's snapshot is in there.
    const archives = listArchives(post);
    const wave = archives.find((a) => a.label === "wave");
    expect(wave?.totalTasks).toBe(2);
    expect(wave?.sourceWorkstreams.map((s) => s.name)).toEqual(["alpha"]);
    post.close();
  });

  it("--archive <nonexistent> --yes: ArchiveNotFoundError, workstream UNTOUCHED", async () => {
    const { stderr, exitCode } = await runCli(
      ["workstream", "destroy", "-w", "alpha", "--archive", "no-such-archive", "--yes"],
      dbPath,
    );
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such archive/i);

    // alpha workstream still has both tasks.
    const post = openDb({ path: dbPath });
    const live = post
      .prepare(
        "SELECT t.local_id FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id WHERE ws.name = ?",
      )
      .all("alpha") as { local_id: string }[];
    expect(live.map((t) => t.local_id).sort()).toEqual(["build", "design"]);
    post.close();
  });

  it("--archive <existing> WITHOUT --yes: dry-run prints 'would archive N tasks to <label>'", async () => {
    await runCli(["archive", "create", "wave"], dbPath);
    const { error, stdout, exitCode } = await runCli(
      ["workstream", "destroy", "-w", "alpha", "--archive", "wave"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stdout).toMatch(/would archive 2 tasks to wave/);
    expect(stdout).toMatch(/dry-run/);

    // Workstream is untouched (dry-run).
    const post = openDb({ path: dbPath });
    const live = post
      .prepare(
        "SELECT t.local_id FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id WHERE ws.name = ?",
      )
      .all("alpha") as { local_id: string }[];
    expect(live.map((t) => t.local_id).sort()).toEqual(["build", "design"]);
    // Archive is empty still.
    const wave = listArchives(post).find((a) => a.label === "wave");
    expect(wave?.totalTasks).toBe(0);
    post.close();
  });
});

// ─── mu archive search ──────────────────────────────────────────────
//
// Phase 4b. Tests the thin commander glue + the SDK contract end-to-
// end through runCli (in-process buildProgram + parseAsync).

describe("mu archive search", () => {
  beforeEach(async () => {
    // Seed: two archives, each with their own source workstream.
    // alpha has a unique title token + a notes match; beta has its
    // own title.
    await runCli(["archive", "create", "wave"], dbPath);
    await runCli(["archive", "add", "wave", "-w", "alpha"], dbPath);
    await runCli(["archive", "create", "other"], dbPath);
    await runCli(["archive", "add", "other", "-w", "beta"], dbPath);
  });

  it("matches a title across every archive (table)", async () => {
    const { stdout, error, exitCode } = await runCli(["archive", "search", "Build"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stdout).toContain("build");
    expect(stdout).toContain("wave");
    expect(stdout).toContain("hit(s)");
  });

  it("matches a note's content (--json)", async () => {
    const { stdout, error } = await runCli(["archive", "search", "design note", "--json"], dbPath);
    expect(error).toBeUndefined();
    const hits = JSON.parse(stdout.trim()) as Array<{
      archiveLabel: string;
      sourceWorkstream: string;
      originalLocalId: string;
      matchKind: "title" | "note";
      matchSnippet: string;
    }>;
    expect(hits.length).toBe(1);
    expect(hits[0]?.matchKind).toBe("note");
    expect(hits[0]?.archiveLabel).toBe("wave");
    expect(hits[0]?.originalLocalId).toBe("design");
    expect(hits[0]?.matchSnippet).toContain("design note");
  });

  it("--label scopes to a single archive", async () => {
    // Both archives have a title containing 'esign' (Design alpha,
    // Design beta). Without --label we get 2; with --label wave we
    // get 1.
    const all = await runCli(["archive", "search", "esign", "--json"], dbPath);
    const allHits = JSON.parse(all.stdout.trim()) as Array<{ archiveLabel: string }>;
    const labels = new Set(allHits.map((h) => h.archiveLabel));
    expect(labels.size).toBe(2);

    const scoped = await runCli(
      ["archive", "search", "esign", "--label", "wave", "--json"],
      dbPath,
    );
    const scopedHits = JSON.parse(scoped.stdout.trim()) as Array<{ archiveLabel: string }>;
    expect(scopedHits.every((h) => h.archiveLabel === "wave")).toBe(true);
    expect(scopedHits.length).toBeGreaterThan(0);
  });

  it("--label nonexistent → ArchiveNotFoundError; exit 3", async () => {
    const { stderr, exitCode } = await runCli(
      ["archive", "search", "x", "--label", "ghost"],
      dbPath,
    );
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/no such archive/i);
  });

  it("--limit truncates the result set", async () => {
    const { stdout, error } = await runCli(
      ["archive", "search", "esign", "--limit", "1", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    const hits = JSON.parse(stdout.trim()) as unknown[];
    expect(hits).toHaveLength(1);
  });

  it("empty pattern → UsageError; exit 2", async () => {
    const { stderr, exitCode } = await runCli(["archive", "search", ""], dbPath);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/search pattern is required/i);
  });

  it("whitespace-only pattern → UsageError; exit 2", async () => {
    const { stderr, exitCode } = await runCli(["archive", "search", "   "], dbPath);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/search pattern is required/i);
  });

  it("empty results render '(no matches)' + Next steps", async () => {
    const { stdout, error } = await runCli(["archive", "search", "absolutely-nope"], dbPath);
    expect(error).toBeUndefined();
    expect(stdout).toContain("(no matches)");
    expect(stdout).toContain("Next:");
  });

  it("empty results --json emits []", async () => {
    const { stdout, error } = await runCli(
      ["archive", "search", "absolutely-nope", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(JSON.parse(stdout.trim())).toEqual([]);
  });

  it("SQL-injection attempt is parameter-bound; archives table survives", async () => {
    const malicious = "'); DROP TABLE archives; --";
    const { stdout, error } = await runCli(["archive", "search", malicious, "--json"], dbPath);
    expect(error).toBeUndefined();
    expect(JSON.parse(stdout.trim())).toEqual([]);
    // Both archives still listed.
    const list = await runCli(["archive", "list", "--json"], dbPath);
    const arr = JSON.parse(list.stdout.trim()) as Array<{ label: string }>;
    expect(arr.map((a) => a.label).sort()).toEqual(["other", "wave"]);
  });
});
