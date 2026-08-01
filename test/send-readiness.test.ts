// dogfood_send_after_new_dropped — fast-tier coverage for the pure
// decision logic behind the send readiness wait.
//
// The bug: `mu agent send W "/new"` makes pi run an async "Naming
// session before closing…" step. A bracketed paste that arrives during
// that modal is accepted, but the Enter after it is SWALLOWED, leaving
// the prompt typed-but-unsubmitted. The pane then reads needs_input at
// 0.0% context with no error, and the orchestrator waits on a task the
// agent never started.
//
// The fix hinges on one classification: a spinner because the AGENT IS
// WORKING (send now, pi queues it) versus a spinner because a MODAL is
// up (wait, or the Enter is eaten). Both render Braille, so the spinner
// alone cannot separate them — `hasWorkMarker` does, and it is pure, so
// it belongs in the fast tier. Real-pane behaviour is covered by
// test/tmux-send-readiness.integration.test.ts.

import { describe, expect, it } from "vitest";
import { detectPiStatus } from "../src/detect.js";
import { defaultSendReadinessMs, hasWorkMarker } from "../src/tmux.js";
import { withEnv } from "./_env.js";

// Captured verbatim from a real pi pane during the ~1.5s post-/new
// window. The spinner makes the detector say busy; there is NO work
// marker, which is exactly what makes it a modal rather than a turn.
const NAMING_MODAL = [
  "loop.ts, modelbridge.ts, name-session.ts, watch.ts",
  "",
  " ⠴ Naming session before closing…",
  " escape/ctrl+c cancel",
  "────────────────────────────────────────────────────────────────────",
  "/home/u/ws (detached)",
  "↑16k ↓235 R42k CH99.3% $0.106 2.4%/800k (auto)  anthropic/x • medium",
].join("\n");

// A pane mid-turn: spinner AND a work marker.
const WORKING = [
  " Took 0.6s",
  " ⠧ Working...",
  "────────────────────────────────────────────────────────────────────",
  "/home/u/ws (detached)",
  "↑16k ↓456 R23k CH96.2% $0.105 2.6%/800k (auto)  anthropic/x • medium",
].join("\n");

const WORKING_INTERRUPT = [
  " ⠙ Thinking (esc to interrupt)",
  "────────────────────────────────────────────────────────────────────",
  "/home/u/ws (detached)",
].join("\n");

const IDLE = [
  " ✓ New session started",
  "────────────────────────────────────────────────────────────────────",
  "────────────────────────────────────────────────────────────────────",
  "/home/u/ws (detached)",
  "0.0%/800k (auto)                                anthropic/x • medium",
].join("\n");

describe("send readiness: modal vs working classification", () => {
  // The load-bearing distinction. If this inverts, either the bug comes
  // back (modal treated as working → paste into the modal) or every send
  // into a busy agent pays the full 15s budget.
  it("the post-/new naming modal is busy but has NO work marker", () => {
    expect(detectPiStatus(NAMING_MODAL)).toBe("busy");
    expect(hasWorkMarker(NAMING_MODAL)).toBe(false);
  });

  it("a working pane is busy AND has a work marker", () => {
    expect(detectPiStatus(WORKING)).toBe("busy");
    expect(hasWorkMarker(WORKING)).toBe(true);
    expect(detectPiStatus(WORKING_INTERRUPT)).toBe("busy");
    expect(hasWorkMarker(WORKING_INTERRUPT)).toBe(true);
  });

  it("an idle pane is neither busy nor working", () => {
    expect(detectPiStatus(IDLE)).toBe("needs_input");
    expect(hasWorkMarker(IDLE)).toBe(false);
  });

  // Guards the tail window: a work marker scrolled far above the
  // current frame must not make a later modal look like a live turn.
  it("only recent output counts as a work marker", () => {
    const stale = `${"Working...\n"}${"filler\n".repeat(60)}${NAMING_MODAL}`;
    expect(hasWorkMarker(stale)).toBe(false);
  });
});

describe("defaultSendReadinessMs", () => {
  const KEY = "MU_SEND_READINESS_MS";

  it("defaults to 15s — longer than spawn's 10s, since the blocker is an LLM call", async () => {
    await withEnv(KEY, undefined, async () => {
      expect(defaultSendReadinessMs()).toBe(15_000);
    });
  });

  it("honours a valid override, including 0 to disable", async () => {
    await withEnv(KEY, "2500", async () => {
      expect(defaultSendReadinessMs()).toBe(2500);
    });
    await withEnv(KEY, "0", async () => {
      expect(defaultSendReadinessMs()).toBe(0);
    });
  });

  it("falls back to the default on garbage or negative values", async () => {
    for (const raw of ["abc", "-1", ""]) {
      await withEnv(KEY, raw, async () => {
        expect(defaultSendReadinessMs()).toBe(15_000);
      });
    }
  });
});
