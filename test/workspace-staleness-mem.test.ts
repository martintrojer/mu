// Tests for src/workspace.ts decorateWithStaleness: per-row
// commitsBehindMain population, the (backend, parentRef) memoization
// (review_code_decorate_with_staleness_n_plus_one regression), and
// the in-flight concurrency cap.
//
// Split out of test/workspace.test.ts under
// testreview_test_files_past_800loc — backends + commitsBehind live
// in test/workspace-backends.test.ts; the workspace SDK + close
// integration + orphan surfacing live in test/workspace-sdk.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { gitBackend } from "../src/vcs.js";
import {
  createWorkspace,
  decorateWithStaleness,
  getWorkspaceStaleness,
  listWorkspaces,
} from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";

let stateRoot: string;
let projectRoot: string;
let dbDir: string;
let db: Db;

function setStateDir(dir: string): void {
  process.env.MU_STATE_DIR = dir;
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "mu-ws-state-"));
  setStateDir(stateRoot);
  dbDir = mkdtempSync(join(tmpdir(), "mu-ws-db-"));
  db = openDb({ path: join(dbDir, "mu.db") });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });

  projectRoot = mkdtempSync(join(tmpdir(), "mu-ws-project-"));
  writeFileSync(join(projectRoot, "README"), "hello\n");
});

afterEach(() => {
  db.close();
  for (const dir of [stateRoot, dbDir, projectRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

describe("decorateWithStaleness", () => {
  it("populates commitsBehindMain on every row (null for none-backend)", async () => {
    insertAgent(db, { name: "w2", workstream: "auth", paneId: "%2", status: "busy" });
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    await createWorkspace(db, {
      agent: "w2",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    const rows = listWorkspaces(db, "auth");
    const decorated = await decorateWithStaleness(rows);
    expect(decorated).toHaveLength(2);
    for (const r of decorated) {
      // none-backend always returns null (no notion of main).
      expect(r.commitsBehindMain).toBeNull();
    }
  });

  it("sets commitsBehindMain to null when parent_ref is null", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    // The none-backend explicitly returns parent_ref=null on create,
    // so this should bypass the backend call.
    const decorated = await decorateWithStaleness(listWorkspaces(db, "auth"));
    expect(decorated[0]?.parentRef).toBeNull();
    expect(decorated[0]?.commitsBehindMain).toBeNull();
  });

  it("getWorkspaceStaleness returns the shared shape and null when no workspace exists", async () => {
    const spy = vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => 10);
    try {
      const row = await createWorkspace(db, {
        agent: "worker-1",
        workstream: "auth",
        projectRoot,
        backend: "none",
      });
      db.prepare("UPDATE vcs_workspaces SET backend = 'git', parent_ref = ? WHERE path = ?").run(
        "base-ref",
        row.path,
      );

      await expect(getWorkspaceStaleness(db, "ghost", "auth")).resolves.toBeNull();
      await expect(getWorkspaceStaleness(db, "worker-1", "auth")).resolves.toEqual({
        agentName: "worker-1",
        workstreamName: "auth",
        commitsBehindMain: 10,
        isStale: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("memoizes commitsBehind by (backend, parentRef): N rows = 1 shellout", async () => {
    // Regression for review_code_decorate_with_staleness_n_plus_one:
    // a `watch -n 5 mu state -w X` loop with N agents sharing a
    // parent_ref must NOT fan out N parallel git/jj/sl child processes
    // every 5 seconds. Per-invocation memoization collapses N rows
    // sharing (backend, parentRef) to ONE backend call.
    const spy = vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => 7);
    try {
      const sharedRef = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const rows = [
        {
          agent: "a",
          workstream: "w",
          backend: "git" as const,
          path: "/p/a",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "b",
          workstream: "w",
          backend: "git" as const,
          path: "/p/b",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "c",
          workstream: "w",
          backend: "git" as const,
          path: "/p/c",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "d",
          workstream: "w",
          backend: "git" as const,
          path: "/p/d",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      const decorated = await decorateWithStaleness(rows);
      expect(decorated.map((r) => r.commitsBehindMain)).toEqual([7, 7, 7, 7]);
      // The cache hit assertion: 4 rows, 1 shellout.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("memoizes per (backend, parentRef): distinct refs each shell out once", async () => {
    // Sanity check that the cache key is parentRef-scoped, not
    // global-scoped — distinct parent_refs must each get their own
    // shellout, but each one only once regardless of row count.
    const spy = vi
      .spyOn(gitBackend, "commitsBehind")
      .mockImplementation(async (_path, ref) => (ref === "refA" ? 3 : 11));
    try {
      const rows = [
        {
          agent: "a",
          workstream: "w",
          backend: "git" as const,
          path: "/p/a",
          parentRef: "refA",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "b",
          workstream: "w",
          backend: "git" as const,
          path: "/p/b",
          parentRef: "refA",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "c",
          workstream: "w",
          backend: "git" as const,
          path: "/p/c",
          parentRef: "refB",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "d",
          workstream: "w",
          backend: "git" as const,
          path: "/p/d",
          parentRef: "refB",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      const decorated = await decorateWithStaleness(rows);
      expect(decorated.map((r) => r.commitsBehindMain)).toEqual([3, 3, 11, 11]);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("caps concurrency: never more than 4 in-flight backend calls", async () => {
    // Bounding the fan-out is the second half of the fix. Without a
    // cap, a workstream with 20 unique parent_refs would shell out
    // 20 git/jj/sl children at once. We assert peak in-flight ≤ 4.
    let inFlight = 0;
    let peak = 0;
    const spy = vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      // Yield twice to give other queued workers a chance to start;
      // a broken cap would let all 12 enter the body before any exits.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return 0;
    });
    try {
      const rows = Array.from({ length: 12 }, (_, i) => ({
        agent: `a${i}`,
        workstream: "w",
        backend: "git" as const,
        path: `/p/a${i}`,
        parentRef: `ref-${i}`, // distinct refs → cache never hits, all 12 must shell out
        createdAt: "2026-01-01T00:00:00Z",
      }));
      await decorateWithStaleness(rows);
      expect(spy).toHaveBeenCalledTimes(12);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
