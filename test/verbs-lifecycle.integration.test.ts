// Send / read / close / free verbs from src/agents.ts. Real
// SQLite + mocked tmux executor.
//
// Split out of test/verbs.test.ts under
// testreview_test_files_past_800loc — see test/_verbs-mock.ts for
// the shared MockState / mockTmux harness, and the sibling
// test/verbs-*.test.ts files for the rest of the verbs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentNotFoundError,
  closeAgent,
  freeAgent,
  getAgent,
  insertAgent,
  readAgent,
  sendToAgent,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { type MockState, freshMockState, mockTmux } from "./_verbs-mock.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;
let state: MockState;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-verbs-lifecycle-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  state = freshMockState();
  resetTmuxExecutor();
  setSleepForTests(async () => {}); // no-op delays in send
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
});

// ─── sendToAgent ───────────────────────────────────────────────────────

describe("sendToAgent", () => {
  it("sends through the canonical bracketed-paste protocol", async () => {
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "alice", workstream: "auth" });
    calls.length = 0; // ignore spawn calls
    await sendToAgent(db, "alice", "hello", { workstream: "auth" });
    // Should have emitted the 4-step send protocol.
    const verbs = calls.map((c) => c[0]);
    expect(verbs).toEqual(["copy-mode", "set-buffer", "paste-buffer", "send-keys"]);
    // Targeted at alice's pane id.
    const sendCall = calls.find((c) => c[0] === "send-keys");
    expect(sendCall).toContain(agent.paneId);
  });

  it("throws AgentNotFoundError for unknown agent (no tmux calls)", async () => {
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);
    await expect(sendToAgent(db, "ghost", "hi", { workstream: "auth" })).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
    expect(calls).toEqual([]);
  });
});

// ─── readAgent ─────────────────────────────────────────────────────────

describe("readAgent", () => {
  it("returns scrollback from the agent's pane", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "alice", workstream: "auth" });
    const pane = state.panes.get(agent.paneId);
    if (!pane) throw new Error("setup: pane missing after spawn");
    pane.scrollback = "line one\nline two\n";
    const out = await readAgent(db, "alice", { workstream: "auth" });
    expect(out).toBe("line one\nline two\n");
  });

  it("honors the lines option", async () => {
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);
    await spawnAgent(db, { name: "alice", workstream: "auth" });
    calls.length = 0;
    await readAgent(db, "alice", { lines: 50, workstream: "auth" });
    const captureCall = calls.find((c) => c[0] === "capture-pane");
    expect(captureCall).toContain("-S");
    expect(captureCall).toContain("-50");
  });

  it("throws AgentNotFoundError for unknown agent", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    await expect(readAgent(db, "ghost", { workstream: "auth" })).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });
});

// ─── closeAgent ────────────────────────────────────────────────────────

describe("closeAgent", () => {
  it("kills pane and deletes row", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "alice", workstream: "auth" });
    expect(state.panes.has(agent.paneId)).toBe(true);

    const result = await closeAgent(db, "alice", { workstream: "auth" });
    expect(result).toMatchObject({ killedPane: true, deletedRow: true });
    expect(state.panes.has(agent.paneId)).toBe(false);
    expect(getAgent(db, "alice", "auth")).toBeUndefined();
  });

  it("is idempotent on unknown agent (no tmux calls)", async () => {
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);
    const result = await closeAgent(db, "ghost", { workstream: "auth" });
    expect(result).toMatchObject({
      killedPane: false,
      deletedRow: false,
    });
    expect(calls).toEqual([]);
  });

  it("succeeds even when the tmux pane is already gone", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "alice", workstream: "auth" });
    // Manually delete the pane out from under us.
    state.panes.delete(agent.paneId);

    const result = await closeAgent(db, "alice", { workstream: "auth" });
    expect(result.deletedRow).toBe(true);
    expect(getAgent(db, "alice", "auth")).toBeUndefined();
  });
});

describe("freeAgent", () => {
  it("flips status to 'free' and reports the change", () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "busy" });
    const r = freeAgent(db, "alice", "auth");
    expect(r).toEqual({ previousStatus: "busy", status: "free", changed: true });
    expect(getAgent(db, "alice", "auth")?.status).toBe("free");
  });

  it("is idempotent on an already-free agent", () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "free" });
    const r = freeAgent(db, "alice", "auth");
    expect(r).toEqual({ previousStatus: "free", status: "free", changed: false });
  });

  it("throws AgentNotFoundError on missing agent", () => {
    expect(() => freeAgent(db, "ghost", "auth")).toThrow(AgentNotFoundError);
  });

  it("works from any persisted status (spawning, needs_input, needs_permission)", () => {
    insertAgent(db, {
      name: "a1",
      workstream: "auth",
      paneId: "%1",
      status: "spawning",
    });
    insertAgent(db, {
      name: "a2",
      workstream: "auth",
      paneId: "%2",
      status: "needs_input",
    });
    insertAgent(db, {
      name: "a3",
      workstream: "auth",
      paneId: "%3",
      status: "needs_permission",
    });
    expect(freeAgent(db, "a1", "auth").changed).toBe(true);
    expect(freeAgent(db, "a2", "auth").changed).toBe(true);
    expect(freeAgent(db, "a3", "auth").changed).toBe(true);
    for (const name of ["a1", "a2", "a3"] as const) {
      expect(getAgent(db, name, "auth")?.status).toBe("free");
    }
  });
});
