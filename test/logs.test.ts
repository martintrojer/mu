// Tests for src/logs.ts: agent_logs append + read primitives.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendLog, latestSeq, listLogs } from "../src/logs.js";
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
      workstream: "auth",
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
    expect(r.workstream).toBeNull();
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
