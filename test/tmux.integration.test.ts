// Integration tests for src/tmux.ts. Hits a real tmux server.
//
// Skipped when not running inside tmux. Each test creates a unique
// throwaway session so we never disturb the user's panes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capturePane,
  killSession,
  listPanes,
  listWindows,
  newSession,
  newWindow,
  paneExists,
  resetTmuxExecutor,
  sendToPane,
  sessionExists,
  setPaneTitle,
  splitWindow,
} from "../src/tmux.js";
import { pollUntil } from "./_env.js";
import { freshWorkstream } from "./_fixture.js";

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";

const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("tmux integration (real tmux server)", () => {
  let session: string;

  beforeEach(async () => {
    resetTmuxExecutor();
    // Unique session name per test so parallel test runs don't collide.
    // freshWorkstream() encodes pid + monotonic timestamp + random — fits
    // inside tmux's session-name limits (no '.' or ':' chars).
    session = `mu-${freshWorkstream("t")}`;
    await newSession(session, {
      windowName: "main",
      command: "sh -c 'while true; do sleep 60; done'",
    });
  });

  afterEach(async () => {
    await killSession(session); // idempotent
  });

  it("session round-trip: create, exists, list, kill", async () => {
    expect(await sessionExists(session)).toBe(true);
    await killSession(session);
    expect(await sessionExists(session)).toBe(false);
    // killSession again is idempotent.
    await expect(killSession(session)).resolves.toBeUndefined();
  });

  it("listWindows returns the initial window", async () => {
    const windows = await listWindows(session);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.name).toBe("main");
    expect(windows[0]?.id).toMatch(/^@\d+$/);
  });

  it("newWindow returns a valid pane id", async () => {
    const paneId = await newWindow({
      session,
      name: "Backend",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    expect(paneId).toMatch(/^%\d+$/);
    expect(await paneExists(paneId)).toBe(true);
  });

  it("listPanesInSession returns ALL panes across windows in the session", async () => {
    // Add a second window with two panes.
    const { listPanesInSession, splitWindow } = await import("../src/tmux.js");
    const w1Pane = await newWindow({
      session,
      name: "Backend",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    const w2Pane = await splitWindow({
      target: `${session}:Backend`,
      command: "sh -c 'while true; do sleep 60; done'",
    });

    const panes = await listPanesInSession(session);
    const paneIds = panes.map((p) => p.paneId).sort();
    // Includes the initial 'main' pane + Backend's two panes.
    expect(paneIds).toContain(w1Pane);
    expect(paneIds).toContain(w2Pane);
    // Each pane carries its window id.
    for (const p of panes) {
      expect(p.windowId).toMatch(/^@\d+$/);
      expect(p.paneId).toMatch(/^%\d+$/);
    }
  });

  it("splitWindow adds a pane to an existing window", async () => {
    const win = await newWindow({
      session,
      name: "Backend",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    const split = await splitWindow({
      target: `${session}:Backend`,
      command: "sh -c 'while true; do sleep 60; done'",
    });
    expect(split).toMatch(/^%\d+$/);
    expect(split).not.toBe(win);
    const panes = await listPanes(`${session}:Backend`);
    expect(panes.map((p) => p.paneId).sort()).toEqual([win, split].sort());
  });

  it("setPaneTitle changes pane title and listPanes reflects it", async () => {
    const paneId = await newWindow({
      session,
      name: "Backend",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    await setPaneTitle(paneId, "alice");
    const panes = await listPanes(`${session}:Backend`);
    expect(panes[0]?.title).toBe("alice");
  });

  it("paneExists is false for a never-existed pane id", async () => {
    expect(await paneExists("%999999")).toBe(false);
  });

  it("paneExists transitions true → false after killPane", async () => {
    const paneId = await newWindow({
      session,
      name: "ephemeral",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    expect(await paneExists(paneId)).toBe(true);
    const { killPane } = await import("../src/tmux.js");
    await killPane(paneId);
    await pollUntil(async () => !(await paneExists(paneId)), {
      description: "killed pane disappears",
    });
    expect(await paneExists(paneId)).toBe(false);
  });

  it("capturePane returns pane scrollback as text", async () => {
    const paneId = await newWindow({
      session,
      name: "echo",
      // Print known text and stay alive.
      command: "sh -c 'echo MU_INTEGRATION_MARKER; while true; do sleep 60; done'",
    });
    await pollUntil(
      () => capturePane(paneId).then((content) => content.includes("MU_INTEGRATION_MARKER")),
      { description: "echo marker lands in pane scrollback" },
    );
    const content = await capturePane(paneId);
    expect(content).toContain("MU_INTEGRATION_MARKER");
  });

  // The big one: bracketed-paste actually delivers special chars literally.
  it("sendToPane delivers special characters literally to bash (not parsed as paths)", async () => {
    // Use bash -i so we have a real prompt that processes input.
    const paneId = await newWindow({
      session,
      name: "shell",
      command: "bash --norc --noprofile",
    });
    await pollUntil(() => capturePane(paneId).then((out) => out.trim().includes("bash")), {
      description: "bash prompt appears",
    });

    // The smoking gun for naive send-keys: if `/` were interpreted as a
    // less/vim search command, this command would never reach bash. With
    // bracketed paste it arrives as literal text.
    const marker = `MU_BP_${Date.now()}`;
    await sendToPane(paneId, `echo "${marker} /tmp/has/slashes ?question !bang"`, { delayMs: 200 });

    await pollUntil(
      () =>
        capturePane(paneId).then((out) =>
          out.includes(`${marker} /tmp/has/slashes ?question !bang`),
        ),
      { description: "bracketed-paste command output appears" },
    );
    const output = await capturePane(paneId);
    expect(output).toContain(`${marker} /tmp/has/slashes ?question !bang`);
  });

  it("sendToPane is safe to call when pane is in copy mode", async () => {
    const paneId = await newWindow({
      session,
      name: "shell",
      command: "bash --norc --noprofile",
    });
    await pollUntil(() => capturePane(paneId).then((out) => out.trim().includes("bash")), {
      description: "bash prompt appears",
    });

    // Force copy-mode on the pane to verify the copy-mode -q step exits it.
    const { tmux } = await import("../src/tmux.js");
    await tmux(["copy-mode", "-t", paneId]);

    const marker = `COPYMODE_${Date.now()}`;
    await sendToPane(paneId, `echo ${marker}`, { delayMs: 200 });
    await pollUntil(() => capturePane(paneId).then((out) => out.includes(marker)), {
      description: "copy-mode send output appears",
    });
    const output = await capturePane(paneId);
    expect(output).toContain(marker);
  });
});

if (!TMUX_AVAILABLE) {
  describe("tmux integration", () => {
    it.skip("skipped — set $TMUX (run inside tmux) to enable", () => {});
  });
}
