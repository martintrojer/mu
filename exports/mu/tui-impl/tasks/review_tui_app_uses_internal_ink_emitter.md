---
id: "review_tui_app_uses_internal_ink_emitter"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.3
roi: 183.33
owner: "worker-4"
created_at: "2026-05-13T12:53:14.912Z"
updated_at: "2026-05-13T14:05:18.452Z"
blocked_by: []
blocks: []
---

# REVIEW med: app.tsx mouse path reaches into ink's internal_eventEmitter (private API)

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:15.580Z

```
FILE(S):
  src/cli/tui/app.tsx:240-250

FINDING (non-idiomatic / risk):
  app.tsx reaches into ink's PRIVATE internal event emitter to
  synthesise "fake" keystrokes when the mouse is used:

      const emitKey = (key: string, delayMs: number) => {
        setTimeout(() => stdin.internal_eventEmitter.emit("input", Buffer.from(key)), delayMs);
      };
      replayPendingMouseEvent(pendingMouseEvent, { ... emitKey });

  The header comment acknowledges this:
  > "Ink's public useInput hook is backed by this internal
  >  emitter; replay the same bytes keyboard users type so mouse
  >  scroll/drill stays routed through each popup's existing
  >  keymap switch."

  `internal_eventEmitter` is, by name, NOT public ink API. Its
  signature isn't part of ink's d.ts contract. The TS code uses
  `stdin.internal_eventEmitter` without a typed seam — it works
  because TS doesn't enforce non-existent-property access on the
  ambient ink stdin context (or because there's a local type
  augmentation we missed; either way the dependency is
  documented-as-internal).

WHY IT'S A PROBLEM:
  - An ink minor-version bump renaming or removing
    `internal_eventEmitter` (entirely possible — anything starting
    `internal_` is fair game per node ecosystem convention) breaks
    the entire mouse-scroll path silently. No typed-error wrapper
    here, no test that runs against the actual emitter — just a
    runtime assumption.
  - The "fake-keystroke replay" pattern means the popup's keymap
    is being driven by mouse events through an indirect channel,
    instead of receiving mouse events directly. That's clever but
    inverts the data flow: each popup's `useInput` callback sees
    ink-native key events that originated from a mouse event,
    making it harder to debug "did this come from the keyboard or
    a wheel scroll?" in popup callbacks.
  - The current reaction to the mouse event happens via setTimeout
    (in some branches, multiple setTimeouts staggered by 8ms), so
    the popup's render state and the dispatched key can desync if
    the user clicks rapidly.

PROPOSED FIX:
  Two paths:

  A. PRAGMATIC — add a typed seam for the emitter.
     Define `interface InkStdinWithEmitter extends ReturnType<typeof useStdin> { internal_eventEmitter: EventEmitter; }` and cast at one site (with a runtime check `if ("internal_eventEmitter" in stdin)`). Add a one-line test that asserts ink still exposes the emitter on import. Cost ≈ 30 LOC.

  B. PROPER — eliminate the emitter dependency.
     Each popup that wants mouse-driven nav can subscribe to
     useMouse() directly (the hook already exists in mouse.ts).
     Lift mouse-to-action translation out of <App> and into the
     popup-level `useInput` siblings. Pop-ups already own j/k
     handling; they can own scroll-wheel handling too. Removes
     the entire `replayPendingMouseEvent` indirection and the
     synthetic `emitKey` setTimeout chain.

  Path A is the smaller subset (<100 LOC). Path B is more invasive
  but eliminates the `internal_eventEmitter` dependency altogether.

EFFORT NOTE:
  A: 0.25d, low risk, sidesteps ink upgrade pain.
  B: 0.6d, touches every popup (subscribe to useMouse + handle
  scroll/doubleclick events), but architecturally cleaner.
```

### #2 by "worker-4", 2026-05-13T14:05:18.452Z

```
CLOSE: 7afa797: typed wrapper (getInkInternalEmitter + InkStdinWithEmitter) + runtime check at the one call site in app.tsx; new test/tui-app-emitter-shape.test.ts asserts ink StdinContext.d.ts still declares internal_eventEmitter so CI fails loudly if ink drops the field. Mouse degrades gracefully when emitter missing. Four greens + bundle smoke pass. Path B (useMouse → popups) deferred per task plan.
```
