// Tests for src/logs.ts: agent_logs append + read primitives.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  CLAIM_EVENT_PREFIX,
  appendLog,
  displayEventPayload,
  emitEvent,
  formatClaimEvent,
  lastClaimActor,
  latestSeq,
  listLogs,
  parseClaimEventActor,
} from "../src/logs.js";
import { addTask } from "../src/tasks.js";
import { claimTask } from "../src/tasks/claim.js";
import { ensureWorkstream } from "../src/workstream.js";

describe("logs SDK", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-logs-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    ensureWorkstream(db, "auth");
    ensureWorkstream(db, "billing");
    // ensureWorkstream auto-emits a system 'workstream init' event;
    // wipe the log so each test starts from a clean cursor and can
    // assert on payload contents directly.
    db.prepare("DELETE FROM agent_logs").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'agent_logs'").run();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── appendLog ──────────────────────────────────────────────────────

  it("appendLog assigns a monotonic seq and returns the row", () => {
    const a = appendLog(db, { workstream: "auth", source: "worker-1", payload: "hi" });
    const b = appendLog(db, { workstream: "auth", source: "worker-1", payload: "hello" });
    expect(a.seq).toBeLessThan(b.seq);
    expect(a).toMatchObject({
      workstreamName: "auth",
      source: "worker-1",
      kind: "message",
      payload: "hi",
    });
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appendLog defaults kind to 'message'", () => {
    const r = appendLog(db, { workstream: "auth", source: "user", payload: "x" });
    expect(r.kind).toBe("message");
  });

  it("appendLog accepts an explicit kind", () => {
    const r = appendLog(db, {
      workstream: "auth",
      source: "system",
      kind: "event",
      payload: '{"verb":"task.close","id":"design"}',
    });
    expect(r.kind).toBe("event");
  });

  it("appendLog accepts null workstream (machine-wide)", () => {
    const r = appendLog(db, { workstream: null, source: "user", payload: "x" });
    expect(r.workstreamName).toBeNull();
  });

  // ─── listLogs ───────────────────────────────────────────────────────

  it("listLogs returns oldest-first", () => {
    appendLog(db, { workstream: "auth", source: "u", payload: "1" });
    appendLog(db, { workstream: "auth", source: "u", payload: "2" });
    appendLog(db, { workstream: "auth", source: "u", payload: "3" });
    expect(listLogs(db).map((r) => r.payload)).toEqual(["1", "2", "3"]);
  });

  it("listLogs filters by workstream", () => {
    appendLog(db, { workstream: "auth", source: "u", payload: "a" });
    appendLog(db, { workstream: "billing", source: "u", payload: "b" });
    expect(listLogs(db, { workstream: "auth" }).map((r) => r.payload)).toEqual(["a"]);
    expect(listLogs(db, { workstream: "billing" }).map((r) => r.payload)).toEqual(["b"]);
  });

  it("listLogs with workstream=null returns ONLY machine-wide entries", () => {
    appendLog(db, { workstream: "auth", source: "u", payload: "ws" });
    appendLog(db, { workstream: null, source: "u", payload: "global" });
    expect(listLogs(db, { workstream: null }).map((r) => r.payload)).toEqual(["global"]);
  });

  it("listLogs with workstream=undefined returns every workstream + global", () => {
    appendLog(db, { workstream: "auth", source: "u", payload: "a" });
    appendLog(db, { workstream: "billing", source: "u", payload: "b" });
    appendLog(db, { workstream: null, source: "u", payload: "g" });
    expect(
      listLogs(db)
        .map((r) => r.payload)
        .sort(),
    ).toEqual(["a", "b", "g"]);
  });

  it("listLogs `since` returns rows STRICTLY after the given seq (cursor semantics)", () => {
    const a = appendLog(db, { workstream: "auth", source: "u", payload: "1" });
    const b = appendLog(db, { workstream: "auth", source: "u", payload: "2" });
    appendLog(db, { workstream: "auth", source: "u", payload: "3" });
    expect(listLogs(db, { since: a.seq }).map((r) => r.payload)).toEqual(["2", "3"]);
    expect(listLogs(db, { since: b.seq }).map((r) => r.payload)).toEqual(["3"]);
  });

  it("listLogs `limit` without `since` returns the most recent N (oldest-first)", () => {
    for (let i = 1; i <= 5; i++) {
      appendLog(db, { workstream: "auth", source: "u", payload: String(i) });
    }
    expect(listLogs(db, { limit: 3 }).map((r) => r.payload)).toEqual(["3", "4", "5"]);
  });

  it("listLogs filters by source", () => {
    appendLog(db, { workstream: "auth", source: "worker-1", payload: "a" });
    appendLog(db, { workstream: "auth", source: "worker-2", payload: "b" });
    appendLog(db, { workstream: "auth", source: "worker-1", payload: "c" });
    expect(listLogs(db, { source: "worker-1" }).map((r) => r.payload)).toEqual(["a", "c"]);
  });

  it("listLogs filters by kind", () => {
    appendLog(db, { workstream: "auth", source: "u", payload: "x" });
    appendLog(db, { workstream: "auth", source: "system", kind: "event", payload: "y" });
    expect(listLogs(db, { kind: "event" }).map((r) => r.payload)).toEqual(["y"]);
  });

  it("listLogs returns [] on no match", () => {
    expect(listLogs(db, { workstream: "auth" })).toEqual([]);
    appendLog(db, { workstream: "auth", source: "u", payload: "x" });
    expect(listLogs(db, { workstream: "auth", since: 999 })).toEqual([]);
  });

  // ─── latestSeq ──────────────────────────────────────────────────────

  it("latestSeq returns 0 on an empty table", () => {
    expect(latestSeq(db)).toBe(0);
  });

  it("latestSeq returns the max seq", () => {
    const r = appendLog(db, { workstream: "auth", source: "u", payload: "x" });
    expect(latestSeq(db)).toBe(r.seq);
    const r2 = appendLog(db, { workstream: "auth", source: "u", payload: "y" });
    expect(latestSeq(db)).toBe(r2.seq);
  });

  // ─── FK CASCADE on workstream destroy ───────────────────────────────

  it("destroying a workstream cascade-deletes its log rows", () => {
    appendLog(db, { workstream: "auth", source: "u", payload: "a" });
    appendLog(db, { workstream: "billing", source: "u", payload: "b" });
    db.prepare("DELETE FROM workstreams WHERE name = ?").run("auth");
    expect(listLogs(db).map((r) => r.payload)).toEqual(["b"]);
  });

  // ─── seq is durable across deletes (AUTOINCREMENT semantics) ────────

  it("seq does NOT recycle after deletes (cursor durability)", () => {
    const a = appendLog(db, { workstream: "auth", source: "u", payload: "a" });
    const b = appendLog(db, { workstream: "auth", source: "u", payload: "b" });
    db.prepare("DELETE FROM agent_logs WHERE seq = ?").run(a.seq);
    db.prepare("DELETE FROM agent_logs WHERE seq = ?").run(b.seq);
    const c = appendLog(db, { workstream: "auth", source: "u", payload: "c" });
    expect(c.seq).toBeGreaterThan(b.seq);
  });
});

// ─── claim-event structured-prefix protocol ─────────────────────────────────
//
// review_code_last_claim_actor_brittle: the consumer (lastClaimActor)
// previously prefix-matched a free-prose payload AND was capped at
// the most recent 100 events. Both failure modes are covered here:
//
//   1. format/parse roundtrip on the structured prefix
//   2. displayEventPayload strips the prefix for human render
//   3. lastClaimActor finds the actor across an arbitrarily-long
//      event tail (the >100-events regression that the cap silently
//      hid)

describe("claim event structured prefix", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-claim-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    ensureWorkstream(db, "auth");
    db.prepare("DELETE FROM agent_logs").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'agent_logs'").run();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("formatClaimEvent produces a tab-delimited prefix with prose tail", () => {
    const p = formatClaimEvent({
      localId: "design",
      actor: "alice",
      anonymous: false,
      prose: "task claim design by alice (was owner=none)",
    });
    expect(p).toBe(
      `${CLAIM_EVENT_PREFIX}\tdesign\tactor=alice\tself=0\ttask claim design by alice (was owner=none)`,
    );
  });

  it("parseClaimEventActor reads the actor= field; null on non-claim payloads", () => {
    const p = formatClaimEvent({
      localId: "foo",
      actor: "bob",
      anonymous: true,
      prose: "task claim foo by bob --self (anonymous, owner stays NULL)",
    });
    expect(parseClaimEventActor(p)).toBe("bob");
    expect(parseClaimEventActor("task release foo (was owner=alice)")).toBeNull();
    expect(parseClaimEventActor("")).toBeNull();
  });

  it("displayEventPayload strips the structured prefix; passes other payloads through", () => {
    const p = formatClaimEvent({
      localId: "x",
      actor: "u",
      anonymous: false,
      prose: "task claim x by u (was owner=none)",
    });
    expect(displayEventPayload(p)).toBe("task claim x by u (was owner=none)");
    expect(displayEventPayload("task release y")).toBe("task release y");
  });

  it("emitted claim payloads carry the structured prefix; mu log render shows the prose", async () => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 80,
      effortDays: 1,
    });
    await claimTask(db, "design", { self: true, actor: "orchestrator", workstream: "auth" });
    const events = listLogs(db, { workstream: "auth", kind: "event" });
    const claim = events.find((e) => e.payload.startsWith(CLAIM_EVENT_PREFIX));
    expect(claim).toBeDefined();
    if (!claim) return;
    // Producer emits the structured prefix; the prose tail still
    // contains the human-readable summary (so existing payload-prose
    // assertions in test/tasks.test.ts keep working).
    expect(claim.payload).toContain("actor=orchestrator");
    expect(claim.payload).toContain("self=1");
    expect(claim.payload).toContain("task claim design by orchestrator --self");
    // The display layer strips the prefix.
    expect(displayEventPayload(claim.payload)).toMatch(/^task claim design by orchestrator --self/);
  });

  it("lastClaimActor recovers the actor across 100+ unrelated intervening events", async () => {
    // Regression test for the >100-events failure mode the old
    // limit=100 ceiling silently hid: claim a task, then bury the
    // claim event under a flood of unrelated events, then assert
    // lastClaimActor STILL returns the original actor.
    addTask(db, { localId: "foo", workstream: "auth", title: "F", impact: 80, effortDays: 1 });
    await claimTask(db, "foo", { self: true, actor: "deploy-bot", workstream: "auth" });
    // Bury the claim event under a flood of unrelated events.
    for (let i = 0; i < 250; i++) {
      emitEvent(db, "auth", `task note foo by user (note #${i})`);
    }
    // Throw in some claim events for OTHER tasks so the LIKE filter
    // has to actually filter, not just return MAX(seq) of all claims.
    addTask(db, { localId: "bar", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    await claimTask(db, "bar", { self: true, actor: "some-other-actor", workstream: "auth" });
    expect(lastClaimActor(db, "auth", "foo")).toBe("deploy-bot");
    expect(lastClaimActor(db, "auth", "bar")).toBe("some-other-actor");
    expect(lastClaimActor(db, "auth", "never-claimed")).toBeNull();
  });

  it("lastClaimActor returns the MOST RECENT actor when a task is reclaimed", async () => {
    addTask(db, { localId: "foo", workstream: "auth", title: "F", impact: 80, effortDays: 1 });
    await claimTask(db, "foo", { self: true, actor: "first", workstream: "auth" });
    // Need to release before re-claim (otherwise TaskAlreadyOwnedError).
    db.prepare("UPDATE tasks SET status='OPEN' WHERE local_id='foo'").run();
    await claimTask(db, "foo", { self: true, actor: "second", workstream: "auth" });
    expect(lastClaimActor(db, "auth", "foo")).toBe("second");
  });

  it("lastClaimActor escapes LIKE wildcards in localId (defensive; valid ids can't contain them)", () => {
    // Even though isValidTaskId rejects `_` as a wildcard, we escape it
    // because it IS a legal char in a task id and the LIKE pattern
    // would otherwise treat it as 'any single char'. Synthesize a
    // claim event for `foo_a` and verify it isn't returned for `foo1a`.
    appendLog(db, {
      workstream: "auth",
      source: "alice",
      kind: "event",
      payload: formatClaimEvent({
        localId: "foo_a",
        actor: "alice",
        anonymous: false,
        prose: "task claim foo_a by alice (was owner=none)",
      }),
    });
    expect(lastClaimActor(db, "auth", "foo_a")).toBe("alice");
    expect(lastClaimActor(db, "auth", "foo1a")).toBeNull();
    expect(lastClaimActor(db, "auth", "fooXa")).toBeNull();
  });
});
