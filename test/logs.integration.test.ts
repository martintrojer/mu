// Tests for src/logs.ts: agent_logs append + read primitives.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendLog, lastClaimActor, latestSeq, listLogs } from "../src/logs.js";
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
    db.prepare("DELETE FROM ops").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'ops'").run();
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

  it("ops OUTLIVE their workstream (no FK cascade — v9 behaviour change)", () => {
    // v1's agent_logs had an FK ON DELETE CASCADE, so destroying a
    // workstream erased its history. The ops log is deliberately
    // FK-free: an op must stay readable after the row it records is
    // gone, which is what makes tombstones and archive markers work
    // (VISION.md § 2b, VOCABULARY.md § op).
    appendLog(db, { workstream: "auth", source: "u", payload: "a" });
    appendLog(db, { workstream: "billing", source: "u", payload: "b" });
    db.prepare("DELETE FROM workstreams WHERE name = ?").run("auth");
    // Both hand-written lines survive the delete. The raw DELETE also
    // fires the capture trigger, appending a workstream TOMBSTONE op —
    // and since v2-retire-log-shim `mu log` no longer filters captured
    // ops out, it is visible here too. (No intent: this DELETE bypasses
    // the SDK's withOpContext. Via `mu workstream destroy` it would
    // carry intent='workstream.destroy'.)
    expect(listLogs(db).map((r) => r.payload)).toContain("a");
    expect(listLogs(db).map((r) => r.payload)).toContain("b");
    const authRows = listLogs(db, { workstream: "auth" });
    expect(authRows.map((r) => r.payload)).toContain("a");
    const tombstones = db
      .prepare("SELECT COUNT(*) AS n FROM ops WHERE op = 'del' AND entity = 'workstream'")
      .get() as { n: number };
    expect(tombstones.n).toBe(1);
  });

  // ─── seq is durable across deletes (AUTOINCREMENT semantics) ────────

  it("seq does NOT recycle after deletes (cursor durability)", () => {
    const a = appendLog(db, { workstream: "auth", source: "u", payload: "a" });
    const b = appendLog(db, { workstream: "auth", source: "u", payload: "b" });
    db.prepare("DELETE FROM ops WHERE seq = ?").run(a.seq);
    db.prepare("DELETE FROM ops WHERE seq = ?").run(b.seq);
    const c = appendLog(db, { workstream: "auth", source: "u", payload: "c" });
    expect(c.seq).toBeGreaterThan(b.seq);
  });
});

// ─── claim attribution (ops.actor) ──────────────────────────────────────────
//
// review_code_last_claim_actor_brittle: v1's consumer (lastClaimActor)
// prefix-matched a free-prose payload AND was capped at the most recent
// 100 events. v1 patched the brittleness by bolting a tab-delimited
// `task.claim<TAB><id><TAB>actor=...` prefix onto the payload.
//
// v2-retire-log-shim deletes that whole apparatus. `withOpContext` seeds
// the actor, the capture trigger writes it to `ops.actor`, and the
// intent is 'task.claim' — so attribution is two indexed columns, and
// the format/parse/strip helpers (formatClaimEvent /
// parseClaimEventActor / displayEventPayload) are gone with nothing to
// replace them. What still matters, and is still covered below:
//
//   1. attribution survives on the `--self` path, where owner_id stays
//      NULL so the payload CANNOT name the actor
//   2. lastClaimActor finds it across an arbitrarily long op tail (the
//      >100-events regression the old cap silently hid)
//   3. re-claim returns the most recent actor

describe("claim attribution via ops.actor", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-claim-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    ensureWorkstream(db, "auth");
    db.prepare("DELETE FROM ops").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'ops'").run();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records the actor on ops.actor, not in the payload prose", async () => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 80,
      effortDays: 1,
    });
    await claimTask(db, "design", { self: true, actor: "orchestrator", workstream: "auth" });
    const claim = listLogs(db, { workstream: "auth" })
      .reverse()
      .find((e) => e.intent === "task.claim");
    expect(claim).toBeDefined();
    expect(claim?.source).toBe("orchestrator");
    // No tab-delimited smuggling left anywhere in the payload.
    expect(claim?.payload).not.toContain("\t");
    expect(claim?.payload).not.toContain("actor=");
    expect(lastClaimActor(db, "auth", "design")).toBe("orchestrator");
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
      appendLog(db, { workstream: "auth", source: "user", payload: `note #${i}` });
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

  it("attribution keys on the EXACT natural key, so similar ids cannot cross-match", async () => {
    // v1 matched a LIKE pattern against prose and had to escape `_`
    // (a LIKE wildcard, and a legal task-id char) to stop `foo_a` from
    // answering for `foo1a`. ops.key is the exact natural key
    // '<ws>/<localId>', so there is no pattern and nothing to escape.
    addTask(db, { localId: "foo_a", workstream: "auth", title: "A", impact: 5, effortDays: 1 });
    await claimTask(db, "foo_a", { self: true, actor: "alice", workstream: "auth" });
    expect(lastClaimActor(db, "auth", "foo_a")).toBe("alice");
    expect(lastClaimActor(db, "auth", "foo1a")).toBeNull();
    expect(lastClaimActor(db, "auth", "fooXa")).toBeNull();
  });
});
