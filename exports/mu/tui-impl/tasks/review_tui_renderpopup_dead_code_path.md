---
id: "review_tui_renderpopup_dead_code_path"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.5
roi: 110.00
owner: "worker-3"
created_at: "2026-05-13T12:53:29.801Z"
updated_at: "2026-05-13T14:54:24.305Z"
blocked_by: []
blocks: []
---

# REVIEW med: doubleclick replays N timers as synthetic j-keys; magic y-2 offset; no setCursor action

## Notes (3)

### #1 by "worker-4", 2026-05-13T12:53:30.291Z

```
FILE(S):
  src/cli/tui/app.tsx:148-159 (mouse path emits replay → popup keymap)
  src/cli/tui/app.tsx:236-250 (replayPendingMouseEvent invocation)
  src/cli/tui/app.tsx:64-92 (replayPendingMouseEvent — pure helper)

FINDING (complexity / dead code path):
  `replayPendingMouseEvent` (an exported pure helper) replays
  mouse `scroll` and `doubleclick` events as synthetic key
  presses (`j`/`k` for scroll, `g` + N×`j` + `` for
  doubleclick). The doubleclick branch:

      if (event.kind === "doubleclick") {
        const rowIndex = Math.max(0, event.y - 2);
        const keys = `g${"j".repeat(rowIndex)}`;
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (key !== undefined) opts.emitKey(key, i * 8);
        }
        return true;
      }

  This synthesises a sequence of keystrokes 8ms apart to navigate
  to row `event.y - 2` and press Enter. So a doubleclick on a
  row 100 rows down → 102 setTimeouts (g + 100×j + return) over
  ~800ms.

WHY IT'S A PROBLEM:
  - Quadratic-ish behaviour: doubleclicking row N enqueues N
    timers. Doubleclick row 50 → 52 timers staggered. If the user
    doubleclicks AGAIN before the first run completes, you have
    100+ in-flight timers all racing the popup's cursor.
  - Magic constants: `event.y - 2` assumes the popup's row 0 is
    at terminal row 2. This is the popup chrome budget; if popup
    chrome changes (which it has — see POPUP_CHROME_ROWS comment
    history), every doubleclick targets a wrong row. The constant
    is hardcoded with no link to POPUP_CHROME_ROWS.
  - The "g" + N×"j" + "" path is a heroic workaround for not
    having a "set cursor to N" popup action. Adding a
    `{kind: "setCursor", index: N}` PopupAction would replace
    the whole sequence with one event.
  - There's no test exercising the doubleclick → row N → Enter
    path against a real popup. Only a unit test against the pure
    helper. So the row-2 offset and the 8ms stagger are
    completely unmonitored at runtime.

PROPOSED FIX:
  Add `{kind: "setCursor", index: number}` to PopupAction. Wire
  applyCursor to handle it (clamp into range). Doubleclick path
  becomes:

      if (event.kind === "doubleclick") {
        const rowIndex = Math.max(0, event.y - POPUP_CHROME_TOP);
        opts.emitAction({ kind: "setCursor", index: rowIndex });
        opts.emitAction({ kind: "drill" });
        return true;
      }

  Two events instead of N timers. Replace `event.y - 2` with the
  named constant and link it to POPUP_CHROME_ROWS.

EFFORT NOTE:
  Touches keys.ts (PopupAction union), scroll.ts (applyCursor),
  every popup that owns a cursor (~7 popups) — but each addition
  is one case. Removes the synthetic key replay altogether (which
  in turn removes the dependency on `internal_eventEmitter` for
  this code path — see review_tui_app_uses_internal_ink_emitter).
  Also reduces app.tsx complexity meaningfully.
  ~0.5d, broader benefit than just this finding.
```

### #2 by "worker-3", 2026-05-13T14:54:19.040Z

```
FILES: src/cli/tui/app.tsx; src/cli/tui/keys.ts; src/cli/tui/popups/scroll.ts; src/cli/tui/use-popup-action-queue.ts; cursor popups under src/cli/tui/popups/; test/tui-mouse-doubleclick.test.ts; test/tui-mouse-state-reset.test.ts; test/tui-scroll.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (0); npm run lint (0); npm run test:fast (0); npm run test (0); npm run build (0); node dist/cli.js --help >/tmp/mu-help-smoke.txt (0)
FINDINGS: doubleclick now emits setCursor then drill; no N-key delayed replay for row drill; POPUP_CHROME_TOP names the mouse row offset and is linked to POPUP_CHROME_ROWS.
DECISION: use an App-owned popup action queue consumed one action per render so setCursor render lands before drill runs.
NEXT: none.
VERIFIED: commit c646b97; all requested gates and bundle smoke passed.
ODDITIES: mouse-wheel scroll still uses the typed internal_eventEmitter seam for one j/k synthetic key as instructed; doubleclick path no longer uses it.
```

### #3 by "worker-3", 2026-05-13T14:54:24.305Z

```
CLOSE: c646b97: setCursor PopupAction; doubleclick path no longer replays N j keys; chrome offset named
```
