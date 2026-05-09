// Tests for src/approvals.ts: human-in-the-loop gate primitive.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  addApproval,
  denyApproval,
  generateApprovalSlug,
  getApproval,
  grantApproval,
  listApprovals,
  timeoutApproval,
  waitApproval,
} from "../src/approvals.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";

describe("approvals SDK", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-approvals-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    ensureWorkstream(db, "auth");
    // The setup ensureWorkstream emits a system event; clear the log so
    // tests can assert on payloads directly.
    db.prepare("DELETE FROM agent_logs").run();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    resetSleep();
  });

  // ─── slug generation ───────────────────────────────────────────────

  it("generateApprovalSlug returns app_<8 hex>", () => {
    const slug = generateApprovalSlug();
    expect(slug).toMatch(/^app_[0-9a-f]{8}$/);
  });

  it("generateApprovalSlug returns distinct values", () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 100; i++) slugs.add(generateApprovalSlug());
    expect(slugs.size).toBe(100);
  });

  // ─── addApproval ───────────────────────────────────────────────────

  it("addApproval inserts and returns the row, defaulting to pending", () => {
    const r = addApproval(db, {
      workstream: "auth",
      reason: "delete a task",
      requestedBy: "worker-1",
    });
    expect(r.status).toBe("pending");
    expect(r.workstream).toBe("auth");
    expect(r.requestedBy).toBe("worker-1");
    expect(r.reason).toBe("delete a task");
    expect(r.decidedBy).toBeNull();
    expect(r.decidedAt).toBeNull();
    expect(r.slug).toMatch(/^app_/);
  });

  it("addApproval honours an explicit slug", () => {
    const r = addApproval(db, {
      slug: "custom-slug",
      workstream: "auth",
      reason: "x",
      requestedBy: "worker-1",
    });
    expect(r.slug).toBe("custom-slug");
  });

  it("addApproval emits a kind='event' log row attributed to the requester", () => {
    addApproval(db, { workstream: "auth", reason: "do thing", requestedBy: "worker-1" });
    const events = listLogs(db, { kind: "event" });
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("worker-1");
    expect(events[0]?.payload).toContain("approval add");
    expect(events[0]?.payload).toContain("requested-by worker-1");
    expect(events[0]?.payload).toContain("do thing");
  });

  // v5: addApproval requires a non-null workstream at the type level
  // (workstream: string in AddApprovalOptions). The v4 nullable
  // contract is gone; the null-rejection runtime test is no longer
  // needed because the type system catches it at the call site.

  // ─── getApproval / listApprovals ──────────────────────────────────

  it("getApproval returns undefined for unknown slug", () => {
    expect(getApproval(db, "ghost", "auth")).toBeUndefined();
  });

  it("listApprovals returns newest-first; filters by workstream + status", () => {
    ensureWorkstream(db, "billing");
    addApproval(db, { workstream: "auth", reason: "a", requestedBy: "u" });
    addApproval(db, { workstream: "billing", reason: "b", requestedBy: "u" });
    const granted = addApproval(db, { workstream: "auth", reason: "c", requestedBy: "u" });
    grantApproval(db, granted.slug, { decidedBy: "user", workstream: "auth" });

    expect(
      listApprovals(db, { workstream: "auth" })
        .map((r) => r.reason)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(listApprovals(db, { workstream: "billing" }).map((r) => r.reason)).toEqual(["b"]);
    expect(listApprovals(db, { status: "granted" }).map((r) => r.reason)).toEqual(["c"]);
    expect(listApprovals(db).length).toBe(3);
  });

  // ─── grant / deny / timeout ────────────────────────────────────────

  it("grantApproval flips status, records decider + timestamp, emits event", () => {
    const a = addApproval(db, { workstream: "auth", reason: "x", requestedBy: "worker-1" });
    const r = grantApproval(db, a.slug, { decidedBy: "user", workstream: "auth" });
    expect(r.status).toBe("granted");
    expect(r.decidedBy).toBe("user");
    expect(r.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const events = listLogs(db, { kind: "event" });
    const grantEvent = events.find((e) => e.payload.startsWith("approval granted"));
    expect(grantEvent).toBeDefined();
    expect(grantEvent?.source).toBe("user");
  });

  it("denyApproval flips status to 'denied'", () => {
    const a = addApproval(db, { workstream: "auth", reason: "x", requestedBy: "worker-1" });
    const r = denyApproval(db, a.slug, { decidedBy: "reviewer-1", workstream: "auth" });
    expect(r.status).toBe("denied");
    expect(r.decidedBy).toBe("reviewer-1");
  });

  it("grant/deny on missing slug throws ApprovalNotFoundError", () => {
    expect(() => grantApproval(db, "ghost", { decidedBy: "u", workstream: "auth" })).toThrow(
      ApprovalNotFoundError,
    );
    expect(() => denyApproval(db, "ghost", { decidedBy: "u", workstream: "auth" })).toThrow(
      ApprovalNotFoundError,
    );
  });

  it("grant/deny on already-decided approval throws ApprovalAlreadyDecidedError", () => {
    const a = addApproval(db, { workstream: "auth", reason: "x", requestedBy: "u" });
    grantApproval(db, a.slug, { decidedBy: "user", workstream: "auth" });
    expect(() => grantApproval(db, a.slug, { decidedBy: "user", workstream: "auth" })).toThrow(
      ApprovalAlreadyDecidedError,
    );
    expect(() => denyApproval(db, a.slug, { decidedBy: "user", workstream: "auth" })).toThrow(
      ApprovalAlreadyDecidedError,
    );
  });

  it("timeoutApproval flips status to 'timeout'", () => {
    const a = addApproval(db, { workstream: "auth", reason: "x", requestedBy: "u" });
    const r = timeoutApproval(db, a.slug, { decidedBy: "system", workstream: "auth" });
    expect(r.status).toBe("timeout");
  });

  // ─── waitApproval ──────────────────────────────────────────────────

  it("waitApproval returns immediately when already decided", async () => {
    setSleepForTests(async () => {});
    const a = addApproval(db, { workstream: "auth", reason: "x", requestedBy: "u" });
    grantApproval(db, a.slug, { decidedBy: "user", workstream: "auth" });
    const r = await waitApproval(db, a.slug, { timeoutMs: 1000, pollMs: 10, workstream: "auth" });
    expect(r.status).toBe("granted");
  });

  it("waitApproval polls until the row transitions; sees grant from another writer", async () => {
    setSleepForTests(async () => {});
    const a = addApproval(db, { workstream: "auth", reason: "x", requestedBy: "u" });
    let pollCount = 0;
    const otherWriterFires = 3;
    setSleepForTests(async () => {
      pollCount++;
      if (pollCount === otherWriterFires) {
        // Simulate another shell granting the approval mid-wait.
        grantApproval(db, a.slug, { decidedBy: "user", workstream: "auth" });
      }
    });
    const r = await waitApproval(db, a.slug, { timeoutMs: 1000, pollMs: 1, workstream: "auth" });
    expect(r.status).toBe("granted");
    expect(pollCount).toBeGreaterThanOrEqual(otherWriterFires);
  });

  it("waitApproval transitions to 'timeout' when deadline elapses", async () => {
    setSleepForTests(async () => {});
    const a = addApproval(db, { workstream: "auth", reason: "x", requestedBy: "u" });
    const r = await waitApproval(db, a.slug, {
      timeoutMs: 0.001,
      pollMs: 0.001,
      workstream: "auth",
    });
    // 0.001ms timeout effectively means "next tick"; should time out.
    expect(r.status).toBe("timeout");
    expect(r.decidedBy).toBe("system");
  });

  it("waitApproval throws ApprovalNotFoundError on missing slug", async () => {
    setSleepForTests(async () => {});
    await expect(
      waitApproval(db, "ghost", { timeoutMs: 1000, pollMs: 10, workstream: "auth" }),
    ).rejects.toThrow(ApprovalNotFoundError);
  });

  // ─── FK CASCADE on workstream destroy ───────────────────────────────

  it("destroying a workstream cascade-deletes its pending approvals", () => {
    addApproval(db, { workstream: "auth", reason: "x", requestedBy: "u" });
    db.prepare("DELETE FROM workstreams WHERE name = 'auth'").run();
    expect(listApprovals(db)).toEqual([]);
  });
});
