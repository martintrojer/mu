// Disk↔DB reconciliation checks (src/disk-recon.ts).
//
// Every test points MU_STATE_DIR at a per-test temp dir and builds the
// on-disk shape by hand, because the whole module's job is disagreement
// between disk and DB — which cannot be produced through the normal
// verbs, since those keep the two in step.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  checkEmptyWorkstreamDirs,
  checkMissingWorkspaceDirs,
  checkRemovedExportsDir,
  checkStaleLocks,
  checkStrayDbFiles,
  checkWorkspaceOrphanDirs,
  findMissingWorkspaceDirs,
  findStrayDbFiles,
  formatBytes,
  measureWorkspaceUsage,
  STALE_LOCK_REPORT_MS,
} from "../src/disk-recon.js";
import { ensureWorkstream } from "../src/workstream.js";

let stateDir: string;
let db: Db;

/** Register a workspace row directly. `createWorkspace` would run a real
 *  VCS backend; these tests only care about the row's `path`. */
function insertWorkspaceRow(workstream: string, agent: string, path: string): void {
  const wsId = (
    db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO agents (name, workstream_id, pane_id, cli, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pi', 'free', datetime('now'), datetime('now'))`,
  ).run(agent, wsId, `%${agent}`);
  const agentId = (
    db.prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ?").get(agent, wsId) as {
      id: number;
    }
  ).id;
  db.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
     VALUES (?, ?, 'git', ?, 'main', datetime('now'))`,
  ).run(agentId, wsId, path);
}

const wsDir = (workstream: string, agent: string): string =>
  join(stateDir, "workspaces", workstream, agent);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mu-disk-recon-"));
  process.env.MU_STATE_DIR = stateDir;
  db = openDb({ path: join(stateDir, "mu.db") });
  ensureWorkstream(db, "alpha");
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  const key = "MU_STATE_DIR";
  delete process.env[key];
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {}
});

describe("DB → disk: rows pointing at nothing", () => {
  it("reports a workspace row whose dir was removed by hand", () => {
    const path = wsDir("alpha", "worker-1");
    mkdirSync(path, { recursive: true });
    insertWorkspaceRow("alpha", "worker-1", path);
    expect(checkMissingWorkspaceDirs(db).severity).toBe("ok");

    // The failure mode: rm -rf instead of `mu workspace free`.
    rmSync(path, { recursive: true });

    const missing = findMissingWorkspaceDirs(db);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.agentName).toBe("worker-1");
    const check = checkMissingWorkspaceDirs(db);
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("1 workspace row");
    // Remediation must name the verb that unregisters it, per workspace.
    expect(check.remediation?.join("\n")).toContain("mu workspace free worker-1 -w alpha");
  });

  it("is ok when there are no workspace rows at all", () => {
    expect(checkMissingWorkspaceDirs(db).severity).toBe("ok");
  });
});

describe("disk → DB: dirs with no row", () => {
  it("reports an orphan dir and marks a stranded one", () => {
    mkdirSync(wsDir("alpha", "worker-1"), { recursive: true });
    // 'ghostws' has no workstreams row -> stranded.
    mkdirSync(wsDir("ghostws", "worker-9"), { recursive: true });

    const check = checkWorkspaceOrphanDirs(db);
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("2 workspace dir(s)");
    expect(check.detail).toContain("1 stranded");
    expect(check.remediation?.join("\n")).toContain("workstream row also gone");
  });

  it("does not report a dir that has a row", () => {
    const path = wsDir("alpha", "worker-1");
    mkdirSync(path, { recursive: true });
    insertWorkspaceRow("alpha", "worker-1", path);
    expect(checkWorkspaceOrphanDirs(db).severity).toBe("ok");
  });
});

describe("empty workstream dirs", () => {
  it("reports an empty parent as ok-severity housekeeping", () => {
    mkdirSync(join(stateDir, "workspaces", "alpha"), { recursive: true });
    const check = checkEmptyWorkstreamDirs();
    // Deliberately ok: `workspace free` leaves this and it harms nothing.
    expect(check.severity).toBe("ok");
    expect(check.detail).toContain("1 empty workstream dir");
    expect(check.detail).toContain("alpha");
  });

  it("does not count a parent that still holds a checkout", () => {
    mkdirSync(wsDir("alpha", "worker-1"), { recursive: true });
    expect(checkEmptyWorkstreamDirs().detail).toBe("no empty workstream dirs");
  });
});

describe("stray DB copies", () => {
  it("finds mu.db* files that are not the live triple, largest first", () => {
    writeFileSync(join(stateDir, "mu.db-wal"), "x");
    writeFileSync(join(stateDir, "mu.db-shm"), "x");
    writeFileSync(join(stateDir, "mu.db.old"), "x".repeat(4096));
    writeFileSync(join(stateDir, "mu.db.v9-20260827"), "x".repeat(8192));

    const stray = findStrayDbFiles(stateDir);
    expect(stray.map((f) => f.name)).toEqual(["mu.db.v9-20260827", "mu.db.old"]);

    const check = checkStrayDbFiles();
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("2 stray DB file(s)");
    // Points at the ops log rather than at a copy for real DR.
    expect(check.remediation?.join("\n")).toContain("mu rebuild");
  });

  it("never counts the live WAL triple", () => {
    writeFileSync(join(stateDir, "mu.db-wal"), "x");
    writeFileSync(join(stateDir, "mu.db-shm"), "x");
    expect(findStrayDbFiles(stateDir)).toEqual([]);
    expect(checkStrayDbFiles().severity).toBe("ok");
  });

  it("ignores unrelated files in the state dir", () => {
    writeFileSync(join(stateDir, "notes.txt"), "x");
    expect(findStrayDbFiles(stateDir)).toEqual([]);
  });
});

describe("removed-verb residue", () => {
  it("reports leftover exports/ dirs", () => {
    mkdirSync(join(stateDir, "exports", "alpha-2026-05-09T17-11-55-918Z"), { recursive: true });
    const check = checkRemovedExportsDir();
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("1 export dir(s)");
    expect(check.remediation?.join("\n")).toContain("removed in 1.0");
  });

  it("is ok with no exports dir at all", () => {
    expect(checkRemovedExportsDir().severity).toBe("ok");
  });
});

describe("stale locks", () => {
  it("reports a lock dir older than the report threshold", () => {
    const lock = join(stateDir, "locks", "spawn-alpha");
    mkdirSync(lock, { recursive: true });
    const old = (Date.now() - STALE_LOCK_REPORT_MS - 60_000) / 1000;
    utimesSync(lock, old, old);

    const check = checkStaleLocks();
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("1 lock dir(s)");
    expect(check.remediation?.join("\n")).toContain("spawn-alpha");
  });

  it("leaves a fresh lock alone (mid-spawn is routine)", () => {
    mkdirSync(join(stateDir, "locks", "spawn-alpha"), { recursive: true });
    expect(checkStaleLocks().severity).toBe("ok");
  });
});

describe("--disk tier: byte accounting", () => {
  it("sums bytes per checkout and flags the orphan ones", () => {
    const tracked = wsDir("alpha", "worker-1");
    mkdirSync(join(tracked, "nested"), { recursive: true });
    writeFileSync(join(tracked, "nested", "big"), "x".repeat(2048));
    insertWorkspaceRow("alpha", "worker-1", tracked);

    const orphan = wsDir("alpha", "worker-2");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "small"), "x".repeat(512));

    const usage = measureWorkspaceUsage(db);
    expect(usage).toHaveLength(2);
    // Sorted largest-first, and recursion reached the nested file.
    expect(usage[0]?.agentName).toBe("worker-1");
    expect(usage[0]?.bytes).toBe(2048);
    expect(usage[0]?.orphan).toBe(false);
    expect(usage[1]?.agentName).toBe("worker-2");
    expect(usage[1]?.orphan).toBe(true);
  });
});

describe("formatBytes", () => {
  it("scales without decimals below the GB mark", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2K");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5M");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0G");
  });
});
