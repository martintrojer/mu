// dogfood_send_after_new_dropped — real-tmux coverage for the send
// readiness wait and submit verification.
//
// The production bug needs a real pi TUI to reproduce (an LLM-backed
// modal swallows the Enter), which no test suite should depend on. What
// IS testable here, against real tmux, is the mechanism the fix relies
// on:
//
//   1. a pane rendering a modal-style spinner (Braille, no work marker)
//      makes sendToPane WAIT rather than paste into it;
//   2. a pane showing a work marker does NOT make it wait, so queuing
//      into a working agent stays fast (this was a real regression
//      during development: every busy send paid the full 15s budget);
//   3. readinessMs: 0 restores the bare fire-and-forget protocol;
//   4. the normal idle path still delivers and does not warn.
//
// Fake TUI states are produced by printing the same glyphs pi uses into
// a plain `sh` pane, so the assertions exercise the real capture ->
// detect -> decide path without needing a model.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  awaitPaneQuiescence,
  capturePane,
  killSession,
  listPanes,
  newSession,
  resetTmuxExecutor,
  type SendWarning,
  sendToPane,
} from "../src/tmux.js";
import { freshWorkstream } from "./_fixture.js";

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";
const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("send readiness (real tmux)", () => {
  let session: string;
  let pane: string;

  beforeEach(async () => {
    resetTmuxExecutor();
    session = `mu-${freshWorkstream("sr")}`;
    await newSession(session, {
      windowName: "main",
      // `cat` keeps the pane alive and echoes pasted text, which is what
      // lets the submit-verification path see a probe at all.
      command: "sh -c 'cat'",
    });
    const panes = await listPanes(session);
    const first = panes[0];
    if (first === undefined) throw new Error("no pane created");
    pane = first.paneId;
  });

  afterEach(async () => {
    try {
      await killSession(session);
    } catch {}
  });

  /** Paint a fake TUI frame into the pane via a separate shell. */
  async function paint(line: string): Promise<void> {
    await sendToPane(pane, `printf '%s\\n' ${JSON.stringify(line)}`, { readinessMs: 0 });
    await new Promise((r) => setTimeout(r, 250));
  }

  it("treats an idle pane as immediately quiescent", async () => {
    const started = Date.now();
    const ready = await awaitPaneQuiescence(pane, 5000);
    expect(ready).toBe(true);
    // 3 confirmations x 250ms of polling, so well under the budget.
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("does NOT wait for a pane that is busy WORKING (queuing stays fast)", async () => {
    // Braille spinner + a work marker = agent mid-turn. pi queues input
    // in this state, so waiting would only add latency.
    await paint(" \u2839 Thinking (esc to interrupt)");
    const started = Date.now();
    const ready = await awaitPaneQuiescence(pane, 8000);
    expect(ready).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("DOES wait out a modal-style spinner (no work marker)", async () => {
    // Braille spinner with no work marker = the post-/new naming modal
    // shape. This is the state that eats the Enter, so it must block
    // until the budget expires rather than pasting into it.
    await paint(" \u2837 Naming session before closing\u2026");
    const started = Date.now();
    const ready = await awaitPaneQuiescence(pane, 1500);
    const elapsed = Date.now() - started;
    expect(ready).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(1400);
  });

  it("readinessMs 0 skips the wait even on a modal-looking pane", async () => {
    await paint(" \u2837 Naming session before closing\u2026");
    const started = Date.now();
    // Would otherwise block for the full budget; 0 opts out entirely.
    await sendToPane(pane, "hello-fast", { readinessMs: 0, delayMs: 0 });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a normal send on an idle pane delivers and does not warn", async () => {
    const warnings: SendWarning[] = [];
    await sendToPane(pane, "READINESS-OK-PROBE", {
      onUndelivered: (w) => warnings.push(w),
    });
    expect(warnings).toEqual([]);
    const capture = await capturePane(pane, { lines: 50 });
    expect(capture).toContain("READINESS-OK-PROBE");
  });

  it("whitespace-only text skips verification without warning", async () => {
    // No probe is derivable from whitespace, so there is nothing to
    // verify. It must not warn: silence here is correct, unlike the
    // stranded case.
    //
    // NOTE: truly empty text ("") is NOT covered, because `tmux
    // set-buffer -b <name> ""` creates no buffer and the following
    // paste-buffer fails. That predates this change (verified against
    // the parent commit) and is out of scope here.
    const warnings: SendWarning[] = [];
    await sendToPane(pane, "   ", { onUndelivered: (w) => warnings.push(w) });
    expect(warnings).toEqual([]);
  });
});
