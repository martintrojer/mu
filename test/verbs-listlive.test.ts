// listLiveAgents (full + status-only + report-only modes) + the
// end-to-end multi-agent verbs scenario (spawn × 3 → list → send →
// close all).
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
  closeAgent,
  getAgent,
  insertAgent,
  listAgents,
  listLiveAgents,
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
  tempDir = mkdtempSync(join(tmpdir(), "mu-verbs-listlive-"));
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

// ─── listLiveAgents ────────────────────────────────────────────────────

describe("listLiveAgents", () => {
  it("returns reconciled agents + orphans + report", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    await spawnAgent(db, { name: "alice", workstream: "auth" });
    await spawnAgent(db, { name: "bob", workstream: "auth" });

    const view = await listLiveAgents(db, { workstream: "auth" });
    expect(view.agents.map((a) => a.name).sort()).toEqual(["alice", "bob"]);
    expect(view.orphans).toEqual([]);
    expect(view.report.prunedGhosts).toBe(0);
  });

  it("scopes to the requested workstream only", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    await spawnAgent(db, { name: "alice", workstream: "auth" });
    await spawnAgent(db, { name: "carol", workstream: "billing" });

    const authView = await listLiveAgents(db, { workstream: "auth" });
    expect(authView.agents.map((a) => a.name)).toEqual(["alice"]);

    const billingView = await listLiveAgents(db, { workstream: "billing" });
    expect(billingView.agents.map((a) => a.name)).toEqual(["carol"]);
  });

  it("surfaces orphans (a pi pane in the session not in the registry)", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    await spawnAgent(db, { name: "alice", workstream: "auth" });
    // Inject an orphan pi pane into the same session.
    const orphanWindowId = `@${state.nextWindowId++}`;
    const orphanPaneId = `%${state.nextPaneId++}`;
    state.windows.get("mu-auth")?.push({ id: orphanWindowId, name: "external" });
    state.panes.set(orphanPaneId, {
      windowId: orphanWindowId,
      paneId: orphanPaneId,
      title: "stranger",
      command: "pi",
    });

    const view = await listLiveAgents(db, { workstream: "auth" });
    expect(view.orphans).toHaveLength(1);
    expect(view.orphans[0]?.paneId).toBe(orphanPaneId);
    // Orphan was NOT auto-adopted into the registry.
    expect(listAgents(db).map((a) => a.name)).toEqual(["alice"]);
  });

  it("prunes ghost rows during the listing", async () => {
    insertAgent(db, { name: "ghost", workstream: "auth", paneId: "%999", status: "busy" });
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);

    const view = await listLiveAgents(db, { workstream: "auth" });
    expect(view.report.prunedGhosts).toBe(1);
    expect(view.agents).toEqual([]);
    expect(getAgent(db, "ghost", "auth")).toBeUndefined();
  });

  // mode propagation — status pollers (mu hud / mu state / mu attach
  // / bare mu) MUST pass mode: "status-only" and read-only diagnostic
  // verbs (mu doctor / mu undo) MUST pass mode: "report-only" so the
  // periodic poll doesn't race a long-running spawn (see
  // bug_agent_spawn_workspace_fk_failure: a `watch -n 5 mu hud` was
  // pruning the spawn's placeholder agent row mid-`git worktree add`,
  // surfacing as a confusing FOREIGN KEY constraint failure on the
  // subsequent vcs_workspaces INSERT).
  describe("mode propagation", () => {
    it("mode: 'status-only' does NOT prune ghost rows (the row survives)", async () => {
      insertAgent(db, { name: "ghost", workstream: "auth", paneId: "%999", status: "busy" });
      const { executor } = mockTmux(state);
      setTmuxExecutor(executor);

      const view = await listLiveAgents(db, { workstream: "auth", mode: "status-only" });
      // The report still COUNTS the would-be-pruned ghost (so callers
      // can surface drift) but the row is intact.
      expect(view.report.prunedGhosts).toBe(1);
      expect(view.report.mode).toBe("status-only");
      expect(view.agents.map((a) => a.name)).toEqual(["ghost"]);
      expect(getAgent(db, "ghost", "auth")?.name).toBe("ghost");
    });

    it("mode: 'report-only' does NOT prune ghost rows either", async () => {
      insertAgent(db, { name: "ghost", workstream: "auth", paneId: "%999", status: "busy" });
      const { executor } = mockTmux(state);
      setTmuxExecutor(executor);

      const view = await listLiveAgents(db, { workstream: "auth", mode: "report-only" });
      expect(view.report.prunedGhosts).toBe(1);
      expect(view.report.mode).toBe("report-only");
      expect(getAgent(db, "ghost", "auth")?.name).toBe("ghost");
    });

    it("mode: 'full' (default) keeps the documented mutating behaviour for `mu agent list`", async () => {
      insertAgent(db, { name: "ghost", workstream: "auth", paneId: "%999", status: "busy" });
      const { executor } = mockTmux(state);
      setTmuxExecutor(executor);

      const view = await listLiveAgents(db, { workstream: "auth" });
      expect(view.report.mode).toBe("full");
      expect(view.report.prunedGhosts).toBe(1);
      expect(getAgent(db, "ghost", "auth")).toBeUndefined();
    });

    it("mode: 'status-only' STILL surfaces orphans (orphan-detection is pure read)", async () => {
      const { executor } = mockTmux(state);
      setTmuxExecutor(executor);
      // Spawn one real agent so the auth session exists in mockTmux,
      // then inject an orphan pi pane into the same session.
      await spawnAgent(db, { name: "alice", workstream: "auth" });
      const orphanWindowId = `@${state.nextWindowId++}`;
      const orphanPaneId = `%${state.nextPaneId++}`;
      state.windows.get("mu-auth")?.push({ id: orphanWindowId, name: "external" });
      state.panes.set(orphanPaneId, {
        windowId: orphanWindowId,
        paneId: orphanPaneId,
        title: "stranger",
        command: "pi",
      });

      const view = await listLiveAgents(db, { workstream: "auth", mode: "status-only" });
      expect(view.orphans).toHaveLength(1);
      expect(view.report.mode).toBe("status-only");
    });
  });
});

// ─── End-to-end multi-agent scenario ───────────────────────────────────

describe("verbs — end-to-end", () => {
  it("spawn 3 → list → send → close all", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);

    await spawnAgent(db, { name: "alice", workstream: "demo" });
    await spawnAgent(db, { name: "bob", workstream: "demo" });
    await spawnAgent(db, { name: "carol", workstream: "demo", tab: "Review" });

    const view1 = await listLiveAgents(db, { workstream: "demo" });
    expect(view1.agents.map((a) => a.name).sort()).toEqual(["alice", "bob", "carol"]);

    await sendToAgent(db, "alice", "hello alice", { workstream: "demo" });
    await sendToAgent(db, "bob", "hello bob", { workstream: "demo" });

    await closeAgent(db, "alice", { workstream: "demo" });
    await closeAgent(db, "bob", { workstream: "demo" });
    await closeAgent(db, "carol", { workstream: "demo" });

    const view2 = await listLiveAgents(db, { workstream: "demo" });
    expect(view2.agents).toEqual([]);
  });
});
