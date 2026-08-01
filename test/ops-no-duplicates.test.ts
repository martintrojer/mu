// v2-retire-log-shim — the guards that would have caught the duplication.
//
// v2-capture left every operator action recorded TWICE: once as a typed
// op from the capture trigger (intent='task.update', key='demo/t1',
// JSON payload) and once as a prose breadcrumb from the src/logs.ts
// shim (intent=NULL, key='demo', free text). Same information, two
// shapes, one unparseable — and the prose copy could never sync,
// because entity='event' is not in SYNCED_ENTITIES.
//
// No test caught it: the orchestrator found it by hand-inspecting the
// ops table. These are the tests that would have.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, SYNCED_ENTITIES, openDb } from "../src/db.js";
import { EVENT_VERB_PREFIXES, latestSeq, listLogs } from "../src/logs.js";
import {
  addBlockEdge,
  addNote,
  addTask,
  claimTask,
  closeTask,
  deleteTask,
  openTask,
  releaseTask,
  removeBlockEdge,
  updateTask,
} from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

interface OpRow {
  seq: number;
  group_id: string;
  intent: string | null;
  entity: string;
  key: string;
  op: string;
  payload: string;
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-nodup-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "demo");
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function ops(): OpRow[] {
  return db
    .prepare("SELECT seq, group_id, intent, entity, key, op, payload FROM ops ORDER BY seq")
    .all() as OpRow[];
}

/** Exercise every task/workstream verb that mutates a portable table. */
async function runFullSession(): Promise<void> {
  addTask(db, { localId: "t1", workstream: "demo", title: "hello", impact: 50, effortDays: 1 });
  addTask(db, { localId: "t2", workstream: "demo", title: "two", impact: 40, effortDays: 2 });
  updateTask(db, "t1", { impact: 80 }, { workstream: "demo" });
  addNote(db, "t1", "a note", { workstream: "demo" });
  addBlockEdge(db, "demo", "t1", "t2");
  removeBlockEdge(db, "demo", "t1", "t2");
  insertAgent(db, { name: "worker-1", workstream: "demo", paneId: "%1", status: "free" });
  await claimTask(db, "t1", { workstream: "demo", agentName: "worker-1" });
  releaseTask(db, "t1", { workstream: "demo" });
  closeTask(db, "t1", { workstream: "demo" });
  openTask(db, "t1", { workstream: "demo" });
  deleteTask(db, "t2", "demo");
}

describe("ops log has no duplicate records of one change", () => {
  // THE test. Two ops in one group that name the same entity+key with
  // the same op-type are, by definition, two records of one change.
  // Before this fix, every task verb produced exactly that.
  it("no two ops in a group describe the same (entity, key, op)", async () => {
    await runFullSession();
    const seen = new Map<string, OpRow[]>();
    for (const row of ops()) {
      const k = [row.group_id, row.entity, row.key, row.op].join(" | ");
      const list = seen.get(k);
      if (list === undefined) seen.set(k, [row]);
      else list.push(row);
    }
    const dupes = [...seen.entries()].filter(([, rows]) => rows.length > 1);
    expect(
      dupes.map(([k, rows]) => `${k} x${rows.length}`),
      "one change must be recorded once",
    ).toEqual([]);
  });

  // The prose copy carried the same facts under a different key
  // ('demo' instead of 'demo/t1'), so it dodged the check above. Pin the
  // entity itself: nothing may write entity='event' any more.
  it("no op uses the retired entity='event'", async () => {
    await runFullSession();
    expect(ops().filter((r) => r.entity === "event")).toEqual([]);
  });

  it("every op carries a non-null intent (no exceptions)", async () => {
    await runFullSession();
    const intentless = ops().filter((r) => r.intent === null);
    expect(
      intentless.map((r) => `#${r.seq} ${r.entity} ${r.key} ${r.payload.slice(0, 40)}`),
      "an intent-less op cannot be rendered without prose prefix-matching",
    ).toEqual([]);
  });

  it("a 4-command session writes exactly 4 ops (was 8)", () => {
    // The orchestrator's measured case, frozen as a test.
    addTask(db, { localId: "t1", workstream: "demo", title: "hello", impact: 50, effortDays: 1 });
    updateTask(db, "t1", { impact: 80 }, { workstream: "demo" });
    closeTask(db, "t1", { workstream: "demo" });
    const rows = ops();
    expect(rows.map((r) => r.intent)).toEqual([
      "workstream.init",
      "task.add",
      "task.update",
      "task.close",
    ]);
    expect(rows.map((r) => r.key)).toEqual(["demo", "demo/t1", "demo/t1", "demo/t1"]);
  });

  it("captured payloads are JSON, so they are renderable without prose parsing", async () => {
    await runFullSession();
    for (const row of ops()) {
      // Tombstones legitimately carry '{}'.
      expect(row.payload.startsWith("{"), `payload not JSON: ${row.payload}`).toBe(true);
    }
  });
});

describe("mu log stays functional and its --tail cursor is consistent", () => {
  // The trap worker-1 hit: `latestSeq` is the cursor INTO what `mu log`
  // shows. If the two disagree, `--tail` starts past rows the non-tail
  // view already displayed and silently skips them. Removing the entity
  // filter changed listLogs' row set, so this must be re-pinned.
  it("latestSeq equals the max seq listLogs actually returns", async () => {
    await runFullSession();
    const rows = listLogs(db, { workstream: "demo" });
    expect(rows.length).toBeGreaterThan(0);
    const maxShown = Math.max(...rows.map((r) => r.seq));
    expect(latestSeq(db, "demo")).toBe(maxShown);
    // Unscoped form too.
    const allRows = listLogs(db, {});
    expect(latestSeq(db)).toBe(Math.max(...allRows.map((r) => r.seq)));
  });

  it("a normal session still returns log rows (mu log is not empty)", async () => {
    await runFullSession();
    expect(listLogs(db, { workstream: "demo" }).length).toBeGreaterThan(5);
  });

  // ops.key is the natural key: workstream rows are 'demo', everything
  // inside is 'demo/t1'. Scoping on `key = 'demo'` alone would hide
  // nearly every op in the workstream.
  it("workstream scoping includes qualified keys, not just the bare name", async () => {
    await runFullSession();
    const rows = listLogs(db, { workstream: "demo" });
    expect(rows.some((r) => r.workstreamName === "demo")).toBe(true);
    expect(rows.some((r) => r.workstreamName?.startsWith("demo/"))).toBe(true);
  });

  it("scoping does not leak between similarly-named workstreams", async () => {
    ensureWorkstream(db, "demo2");
    addTask(db, { localId: "x", workstream: "demo2", title: "X", impact: 5, effortDays: 1 });
    await runFullSession();
    const rows = listLogs(db, { workstream: "demo" });
    expect(rows.every((r) => !(r.workstreamName ?? "").startsWith("demo2"))).toBe(true);
  });
});

describe("machine-local lifecycle ops", () => {
  // The other half of the split: these mutate NO portable table, so no
  // trigger can see them and the emit must stay.
  it("agent lifecycle ops exist, carry agent.* intents, and are machine-local", async () => {
    const { spawnAgent } = await import("../src/agents.js");
    // insertAgent is the pure-DB path; use it plus a free to avoid tmux.
    insertAgent(db, { name: "worker-1", workstream: "demo", paneId: "%1", status: "busy" });
    const { freeAgent } = await import("../src/agents.js");
    freeAgent(db, "worker-1", "demo");
    expect(typeof spawnAgent).toBe("function");

    const agentOps = ops().filter((r) => r.entity === "agent");
    expect(agentOps.length).toBeGreaterThan(0);
    for (const row of agentOps) {
      expect(row.intent, "agent op must name its intent").not.toBeNull();
      expect(row.intent?.startsWith("agent.")).toBe(true);
    }
    // Machine-local: `agents` holds pane_id, meaningless on a peer.
    expect(([...SYNCED_ENTITIES] as string[]).includes("agent")).toBe(false);
    expect(([...SYNCED_ENTITIES] as string[]).includes("workspace")).toBe(false);
  });

  it("every declared prose verb prefix belongs to a machine-local entity", () => {
    // If a `task ...` prefix ever reappears here, a duplicate emitter
    // came back: task mutations are captured by triggers.
    for (const verb of EVENT_VERB_PREFIXES) {
      const entity = verb.split(" ")[0];
      expect(["agent", "workspace", "workstream"], `${verb} should not be prose-emitted`).toContain(
        entity,
      );
    }
    expect(EVENT_VERB_PREFIXES.some((v) => v.startsWith("task "))).toBe(false);
  });
});
