// Tests for `mu workstream destroy --empty` — sweep every empty
// workstream (zero tasks, agents, vcs_workspaces).
//
// Coverage map (mirrors workstream_destroy_empty_sweep design note):
//
//   1. dry-run: 2 empty + 2 non-empty seeded; only the empties show.
//   2. --yes: both empties destroyed; non-empties untouched.
//   3. one empty has a live tmux session; --yes kills it.
//   4. --empty + -w → mutually exclusive (UsageError; exit 2).
//   5. --empty + --archive → mutually exclusive (UsageError; exit 2).
//   6. mid-sweep failure (kill-session throws on one ws) → others
//      still run; failure surfaced in summary.
//   7. --json shape verified for both dry-run and --yes.
//   8. tmux-only mu-* sessions (no DB row) are surfaced + destroyed.
//   9. mixed: 1 registered-empty + 1 tmux-only → both destroyed.
//  10. tmux session WITHOUT mu- prefix is NEVER matched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import {
  type TmuxExecResult,
  type TmuxExecutor,
  resetTmuxExecutor,
  setTmuxExecutor,
} from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;

interface MockState {
  sessions: Set<string>;
  killed: string[];
  /** Sessions whose kill-session call should throw with an
   *  unrecognized stderr (i.e. NOT the "can't find session" string
   *  killSession swallows). Used to drive the mid-sweep failure path. */
  killShouldFail: Set<string>;
}

function ok(stdout = ""): TmuxExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = ""): TmuxExecResult {
  return { exitCode: 1, stdout: "", stderr };
}

function mockTmux(state: MockState): TmuxExecutor {
  return async (args) => {
    const verb = args[0];
    if (verb === "has-session") {
      const target = args[2];
      return state.sessions.has(target ?? "") ? ok() : fail(`can't find session: ${target}`);
    }
    if (verb === "kill-session") {
      const target = args[2] ?? "";
      if (state.killShouldFail.has(target)) {
        // killSession only swallows /can't find session|session not found/i.
        // Anything else propagates as TmuxError → destroyWorkstream throws.
        return fail("permission denied (mock)");
      }
      if (!state.sessions.has(target)) {
        return fail(`can't find session: ${target}`);
      }
      state.sessions.delete(target);
      state.killed.push(target);
      return ok();
    }
    if (verb === "list-sessions") {
      if (state.sessions.size === 0) return fail("no server running");
      return ok([...state.sessions].join("\n"));
    }
    return fail(`unmocked tmux call: ${args.join(" ")}`);
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-destroy-empty-"));
  // Snapshots / exports / workspaces all default under MU_STATE_DIR;
  // pin to tempDir so the snapshot the sweep takes doesn't pollute
  // the host's state.
  process.env.MU_STATE_DIR = tempDir;
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // best effort
  }
  resetTmuxExecutor();
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

/**
 * Seed: two empty workstreams (`empty-a`, `empty-b`) and two
 * non-empty ones:
 *   - `with-tasks`  has one task
 *   - `with-agent`  has one agent
 * `empty-a` also has an agent-free, task-free registry row whose
 * tmux session is alive (drives the "kill-session on the empty
 * ws" assertion).
 */
function seed(state: MockState): void {
  ensureWorkstream(db, "empty-a");
  ensureWorkstream(db, "empty-b");

  addTask(db, {
    localId: "design",
    workstream: "with-tasks",
    title: "Design",
    impact: 50,
    effortDays: 1,
  });
  insertAgent(db, {
    name: "worker-1",
    workstream: "with-agent",
    paneId: "%99",
    status: "free",
  });
  // empty-a has a live tmux session; empty-b doesn't.
  state.sessions.add("mu-empty-a");
}

// ─── Test cases ─────────────────────────────────────────────────────

describe("mu workstream destroy --empty", () => {
  it("dry-run lists only the empty workstreams (table + JSON)", async () => {
    const state: MockState = {
      sessions: new Set(),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    seed(state);
    db.close();

    // Table form
    const tbl = await runCli(["workstream", "destroy", "--empty"], dbPath);
    expect(tbl.error).toBeUndefined();
    expect(tbl.exitCode).toBeNull();
    expect(tbl.stdout).toContain("empty-a");
    expect(tbl.stdout).toContain("empty-b");
    expect(tbl.stdout).not.toContain("with-tasks");
    expect(tbl.stdout).not.toContain("with-agent");
    // Dry-run hint surfaces the --yes invocation.
    expect(tbl.stdout).toContain("mu workstream destroy --empty --yes");

    // JSON form: array of WorkstreamSummary, sorted by name.
    const j = await runCli(["workstream", "destroy", "--empty", "--json"], dbPath);
    expect(j.error).toBeUndefined();
    const env = JSON.parse(j.stdout.trim()) as {
      items: Array<{
        name: string;
        tmuxAlive: boolean;
        agentCount: number;
        taskCount: number;
      }>;
      count: number;
    };
    const arr = env.items;
    expect(arr.map((w) => w.name)).toEqual(["empty-a", "empty-b"]);
    expect(arr[0]?.tmuxAlive).toBe(true);
    expect(arr[1]?.tmuxAlive).toBe(false);
    expect(arr[0]?.agentCount).toBe(0);
    expect(arr[0]?.taskCount).toBe(0);
    expect(env.count).toBe(2);

    // Nothing actually destroyed.
    db = openDb({ path: dbPath });
    const remaining = (
      db.prepare("SELECT name FROM workstreams ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    expect(remaining).toEqual(["empty-a", "empty-b", "with-agent", "with-tasks"]);
    expect(state.killed).toEqual([]);
  });

  it("--yes destroys every empty workstream and leaves the non-empty ones intact", async () => {
    const state: MockState = {
      sessions: new Set(),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    seed(state);
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    const env = JSON.parse(r.stdout.trim()) as {
      destroyed: number;
      results: Array<{ workstreamName: string; killedTmux: boolean }>;
      failed: unknown[];
    };
    expect(env.destroyed).toBe(2);
    expect(env.failed).toEqual([]);
    expect(env.results.map((x) => x.workstreamName).sort()).toEqual(["empty-a", "empty-b"]);

    // The empty-a tmux session is killed; empty-b never had one.
    expect(state.killed).toEqual(["mu-empty-a"]);

    // Non-empties untouched in the DB.
    db = openDb({ path: dbPath });
    const remaining = (
      db.prepare("SELECT name FROM workstreams ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    expect(remaining).toEqual(["with-agent", "with-tasks"]);
  });

  it("--yes kills the live tmux session on an empty workstream", async () => {
    // Same as the --yes test but pinned: this is the assertion that
    // the kill happens for an empty-but-tmux-alive workstream
    // (regression-locks the "tmux session presence does NOT
    // disqualify" predicate).
    const state: MockState = {
      sessions: new Set(["mu-empty-a"]),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    ensureWorkstream(db, "empty-a");
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    const env = JSON.parse(r.stdout.trim()) as {
      results: Array<{ workstreamName: string; killedTmux: boolean }>;
    };
    expect(env.results).toHaveLength(1);
    expect(env.results[0]?.workstreamName).toBe("empty-a");
    expect(env.results[0]?.killedTmux).toBe(true);
    expect(state.killed).toEqual(["mu-empty-a"]);
  });

  it("ignores agent_logs (audit, not state) — a workstream with only init events is still empty", async () => {
    // ensureWorkstream emits a `workstream init` agent_logs row. The
    // predicate must NOT count that as state, otherwise EVERY
    // registered-but-empty workstream would be filtered out.
    const state: MockState = {
      sessions: new Set(),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    ensureWorkstream(db, "audit-only"); // emits a log row
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    const env = JSON.parse(r.stdout.trim()) as {
      items: Array<{ name: string }>;
      count: number;
    };
    expect(env.items.map((w) => w.name)).toEqual(["audit-only"]);
    expect(env.count).toBe(1);
  });

  it("--empty + -w errors with exit 2 (mutually exclusive)", async () => {
    setTmuxExecutor(mockTmux({ sessions: new Set(), killed: [], killShouldFail: new Set() }));
    ensureWorkstream(db, "empty-a");
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "-w", "empty-a"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/mutually exclusive/i);
    expect(r.stderr).toMatch(/-w|--workstream/);

    // Nothing destroyed.
    db = openDb({ path: dbPath });
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number })
      .n;
    expect(remaining).toBe(1);
  });

  it("--empty + --archive errors with exit 2 (mutually exclusive)", async () => {
    setTmuxExecutor(mockTmux({ sessions: new Set(), killed: [], killShouldFail: new Set() }));
    ensureWorkstream(db, "empty-a");
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--archive", "wave"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/mutually exclusive/i);
    expect(r.stderr).toMatch(/--archive/);
  });

  it("mid-sweep failure: bad kill-session on one ws does NOT abort the others", async () => {
    // empty-a's kill-session throws an unrecognized error → destroyWorkstream
    // raises TmuxError → the cmd captures it into `failed` and keeps
    // going. empty-b still gets destroyed.
    const state: MockState = {
      sessions: new Set(["mu-empty-a", "mu-empty-b"]),
      killed: [],
      killShouldFail: new Set(["mu-empty-a"]),
    };
    setTmuxExecutor(mockTmux(state));
    ensureWorkstream(db, "empty-a");
    ensureWorkstream(db, "empty-b");
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    const env = JSON.parse(r.stdout.trim()) as {
      destroyed: number;
      results: Array<{ workstreamName: string }>;
      failed: Array<{ workstreamName: string; error: string }>;
    };
    expect(env.destroyed).toBe(1);
    expect(env.results.map((x) => x.workstreamName)).toEqual(["empty-b"]);
    expect(env.failed).toHaveLength(1);
    expect(env.failed[0]?.workstreamName).toBe("empty-a");
    expect(env.failed[0]?.error).toMatch(/permission denied|tmux/i);

    // empty-b actually destroyed; empty-a still around because the
    // kill threw before the DB row delete.
    db = openDb({ path: dbPath });
    const remaining = (
      db.prepare("SELECT name FROM workstreams ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    expect(remaining).toEqual(["empty-a"]);
    // empty-b's tmux was killed; empty-a's was attempted-and-failed.
    expect(state.killed).toEqual(["mu-empty-b"]);
  });

  it("surfaces unregistered mu-* tmux sessions in dry-run; created_at renders as em-dash", async () => {
    // Two tmux sessions exist with the mu- prefix but NO DB row in
    // workstreams. listEmptyWorkstreams must surface both.
    const state: MockState = {
      sessions: new Set(["mu-foo", "mu-bar"]),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    db.close();

    // JSON form: synthetic summaries with registered=false,
    // tmuxAlive=true, all counts 0.
    const j = await runCli(["workstream", "destroy", "--empty", "--json"], dbPath);
    expect(j.error).toBeUndefined();
    const env = JSON.parse(j.stdout.trim()) as {
      items: Array<{
        name: string;
        tmuxAlive: boolean;
        registered: boolean;
        agentCount: number;
        taskCount: number;
        noteCount: number;
        edgeCount: number;
        workspaceCount: number;
      }>;
      count: number;
    };
    const arr = env.items;
    expect(arr.map((w) => w.name)).toEqual(["bar", "foo"]);
    for (const ws of arr) {
      expect(ws.registered).toBe(false);
      expect(ws.tmuxAlive).toBe(true);
      expect(ws.agentCount).toBe(0);
      expect(ws.taskCount).toBe(0);
      expect(ws.noteCount).toBe(0);
      expect(ws.edgeCount).toBe(0);
      expect(ws.workspaceCount).toBe(0);
    }

    // Table form: both names present; created_at column renders an
    // em-dash for tmux-only entries (no DB row → no created_at).
    const tbl = await runCli(["workstream", "destroy", "--empty"], dbPath);
    expect(tbl.error).toBeUndefined();
    expect(tbl.stdout).toContain("foo");
    expect(tbl.stdout).toContain("bar");
    expect(tbl.stdout).toContain("\u2014");
  });

  it("--yes destroys unregistered mu-* tmux sessions (no DB rows touched)", async () => {
    const state: MockState = {
      sessions: new Set(["mu-foo", "mu-bar"]),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    const env = JSON.parse(r.stdout.trim()) as {
      destroyed: number;
      results: Array<{ workstreamName: string; killedTmux: boolean }>;
      failed: unknown[];
    };
    expect(env.destroyed).toBe(2);
    expect(env.failed).toEqual([]);
    expect(env.results.map((x) => x.workstreamName).sort()).toEqual(["bar", "foo"]);
    for (const x of env.results) expect(x.killedTmux).toBe(true);
    expect(state.killed.sort()).toEqual(["mu-bar", "mu-foo"]);

    // No DB rows ever existed for these names → still none.
    db = openDb({ path: dbPath });
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number })
      .n;
    expect(remaining).toBe(0);
  });

  it("mixes registered-empty and tmux-only into a single sweep", async () => {
    // empty-a is a registered-empty workstream (with a live tmux
    // session); mu-foo is a tmux-only session (no DB row). Both
    // should be destroyed by --empty --yes.
    const state: MockState = {
      sessions: new Set(["mu-empty-a", "mu-foo"]),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    ensureWorkstream(db, "empty-a");
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    const env = JSON.parse(r.stdout.trim()) as {
      destroyed: number;
      results: Array<{ workstreamName: string; killedTmux: boolean }>;
    };
    expect(env.destroyed).toBe(2);
    expect(env.results.map((x) => x.workstreamName).sort()).toEqual(["empty-a", "foo"]);
    expect(state.killed.sort()).toEqual(["mu-empty-a", "mu-foo"]);

    db = openDb({ path: dbPath });
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number })
      .n;
    expect(remaining).toBe(0);
  });

  it("NEVER matches tmux sessions without the mu- prefix", async () => {
    // 'plain-foo' has no mu- prefix → it must not appear in the
    // sweep, must not be killed, even with --yes. This is the
    // load-bearing safety guarantee: mu only owns mu-* sessions.
    const state: MockState = {
      sessions: new Set(["plain-foo", "random-session"]),
      killed: [],
      killShouldFail: new Set(),
    };
    setTmuxExecutor(mockTmux(state));
    db.close();

    // Dry-run: no entries.
    const j = await runCli(["workstream", "destroy", "--empty", "--json"], dbPath);
    expect(j.error).toBeUndefined();
    expect(JSON.parse(j.stdout.trim())).toEqual({ items: [], count: 0 });

    // --yes: still nothing destroyed; sessions untouched.
    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    const env = JSON.parse(r.stdout.trim()) as {
      destroyed: number;
      results: unknown[];
      failed: unknown[];
    };
    expect(env).toEqual({ destroyed: 0, results: [], failed: [] });
    expect(state.killed).toEqual([]);
    expect(state.sessions.has("plain-foo")).toBe(true);
    expect(state.sessions.has("random-session")).toBe(true);
  });

  it("--yes with no empties is a clean no-op (does NOT take a snapshot)", async () => {
    setTmuxExecutor(mockTmux({ sessions: new Set(), killed: [], killShouldFail: new Set() }));
    addTask(db, {
      localId: "design",
      workstream: "busy",
      title: "Design",
      impact: 50,
      effortDays: 1,
    });
    db.close();

    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    const env = JSON.parse(r.stdout.trim()) as {
      destroyed: number;
      results: unknown[];
      failed: unknown[];
    };
    expect(env).toEqual({ destroyed: 0, results: [], failed: [] });

    db = openDb({ path: dbPath });
    const snaps = (db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n;
    expect(snaps).toBe(0);
  });
});
