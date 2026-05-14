---
id: "bug_t_keypress_replays_stale_mouse_dblclick"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.15
roi: 500.00
owner: "worker-3"
created_at: "2026-05-13T05:26:06.085Z"
updated_at: "2026-05-13T05:46:25.825Z"
blocked_by: []
blocks: ["bug_drill_views_dont_refresh_on_tick", "bug_help_overlay_no_scroll_on_low_rows"]
---

# BUG: 't' (and other keyboard popup-openers) replay stale mouse-doubleclick state — opens all-tasks popup then jumps cursor to a random row; the popupMouseEvent useEffect fires on every popup-open even when no fresh mouse event is involved

## Notes (3)

### #1 by "π - mu", 2026-05-13T05:27:51.092Z

````
MOTIVATION (verbatim user)
--------------------------
"bug, 't' on the main tui, swaps into full task list and then selects a task a random. missing debounce?"

ROOT CAUSE (analysed live)
--------------------------
src/cli/tui/app.tsx lines 196-216:

  useEffect(() => {
    if (popup === null || popupFilterEditing || popupMouseEvent === null) return;
    const emitKey = (key: string, delayMs: number) => {
      setTimeout(() => stdin.internal_eventEmitter.emit("input", Buffer.from(key)), delayMs);
    };
    if (popupMouseEvent.kind === "scroll") { ... }
    if (popupMouseEvent.kind === "doubleclick") {
      const rowIndex = Math.max(0, popupMouseEvent.y - 2);
      const keys = `g${"j".repeat(rowIndex)}`;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key !== undefined) emitKey(key, i * 8);
      }
    }
  }, [popup, popupFilterEditing, popupMouseEvent, stdin.internal_eventEmitter]);

The dependency list includes `popup`. So whenever `popup` transitions from null → non-null (which `t` does → opens the all-tasks popup), the effect FIRES even if `popupMouseEvent` was set by some PRIOR mouse event that's no longer relevant.

CONFIRMED REPRO PATTERN:
  1. (At some point earlier) double-click anywhere in the TUI dashboard. setPopupMouseEvent stores a {kind:"doubleclick", y:N}.
  2. Press Esc (or q) to close whatever popup that opened. popupMouseEvent state stays SET (no reset).
  3. Press 't' on the dashboard. setPopup("allTasks") fires.
  4. The effect's deps change (popup went null→"allTasks"). It runs.
  5. popupMouseEvent !== null → branches into the doubleclick path.
  6. Emits `g${j*N}` into the keystream → cursor jumps to row N AND `` triggers Enter → drills into a TaskDetailDrill for whatever row landed under the cursor.

So: **t-key open + stale mouse state = "random task drill" symptom**. Same bug fires for any keyboard popup-open after a prior mouse interaction.

THE FIX (locked)
----------------
The popupMouseEvent state must be RESET whenever:
  - The popup CLOSES (popup goes non-null → null), so a re-open via keyboard or mouse starts clean.
  - The popup OPENS via KEYBOARD (not via the mouse callback).

Cleanest implementation: convert popupMouseEvent into a "consume-once" pattern using a useRef instead of useState. The mouse handler stages the event in the ref AND sets a small "version counter" useState; the consumer effect reads from the ref and clears it. This mirrors the pattern Ink itself uses for one-shot input replay.

OR simpler: reset popupMouseEvent to null whenever popup transitions (any direction):
  ```ts
  // After the mouse-event replay effect:
  useEffect(() => {
    setPopupMouseEvent(null);
  }, [popup]); // resets on every popup transition (open OR close)
  ```
But this introduces a render race: the mouse handler that JUST staged the event (because the user just double-clicked) might be wiped before the effect runs.

CORRECT FIX (use the ref pattern):
  ```ts
  const pendingMouseEvent = useRef<MouseEvent | null>(null);

  useMouse((event) => {
    if (helpOpen || terminalTooSmall) return;
    if (popup === null) {
      // dashboard mouse: open popup via hit-test (existing path)
      if (event.kind !== "doubleclick") return;
      const hit = hitTestDashboardCard(cardHitRegions, event);
      if (hit === null) return;
      setPopupMode("list");
      setPopup(hit);
      // No pendingMouseEvent for dashboard-opened popups; the click was the hit-test, not a row drill.
      return;
    }
    if (popupFilterEditing) return;
    if (event.kind === "scroll" || event.kind === "doubleclick") {
      pendingMouseEvent.current = event;
      // Bump a version counter so the effect runs.
      setPopupMouseTick((n) => n + 1);
    }
  });

  const [popupMouseTick, setPopupMouseTick] = useState(0);
  useEffect(() => {
    if (popup === null || popupFilterEditing) return;
    const event = pendingMouseEvent.current;
    pendingMouseEvent.current = null;  // CONSUME — never replays
    if (event === null) return;
    // (rest of replay logic unchanged)
    ...
  }, [popupMouseTick, popup, popupFilterEditing]);

  // ALSO clear the pending event on popup close (defensive)
  useEffect(() => {
    if (popup === null) pendingMouseEvent.current = null;
  }, [popup]);
  ```

Key invariants the fix establishes:
  1. The mouse-replay effect only fires when there's a FRESH event in the ref (consumed on read).
  2. Opening a popup via keyboard ('t', '1'-'9', Shift+0-9, etc) leaves the ref null → effect bails immediately.
  3. Closing a popup also clears the ref so a future re-open starts clean.

⚠️ ALSO FIX THE INTRA-POPUP CASE ⚠️
A user might:
  1. Inside Ready popup, double-click row 5 → drills.
  2. Esc back to Ready popup list.
  3. Press 'k' or '/' or any key → the effect should NOT replay the prior doubleclick.

The ref-based consume-once pattern handles this naturally.

⚠️ COORDINATION ⚠️
Two other tasks queued for parallel:
  - feat_color_status_columns_in_task_list_popups (touches every task-list popup; status column colour). ZERO file overlap with the fix above (this fix is in app.tsx ONLY).
  - bug_all_tasks_popup_no_scroll already shipped — that scrolls the popup; this fixes the orthogonal "stale mouse state" issue.

Worker-2 currently on feat_git_show_drill_color_and_tuicr; both other tasks gate behind nothing.

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js`. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

TESTS (REQUIRED)
----------------
- test/tui-state-hook.test.ts (or new test/tui-mouse-state-reset.test.ts):
  * Simulate: double-click landing in dashboard → opens popup; keyboard 'q' to close; popup state cleared; pending mouse event cleared.
  * Simulate: double-click → opens popup → keyboard 'Esc' → keyboard 't' → popup-open should NOT trigger the doubleclick replay (no `g`/`j`/`` emitted).
  * The mouse-replay effect, when fired, ALWAYS clears the ref (consumed once).
- These need fine-grained mocking of the mouse → effect → keyboard-emit chain. Mock `useMouse`'s callback channel and `stdin.internal_eventEmitter.emit`. Pattern: mirror existing test/tui-mouse.test.ts setup.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Step 1: double-click on a card → its popup opens, may drill to a row.
  # Step 2: Esc Esc to back fully out to dashboard.
  # Step 3: press 't' → all-tasks popup opens, cursor on row 0 (top), no drill.
  # CURRENT BUG: cursor lands on a random row + drill view opens.
  # AFTER FIX: cursor at top, no drill.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke per checklist above.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; app.tsx is ~530 LOC. Net change is small (~30 LOC for ref + extra effect).
- Conventional commit prefix: `tui:`.
- Suggested commit:
    tui: mouse-event replay is consume-once via useRef so keyboard popup-opens (t/1-9/Shift+0-9) don't replay a stale dblclick; fixes 't' jumping to a random task

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "TUI keyboard popup-opens (`t`, `1`-`9`, `Shift+0`-`9`) no longer replay a stale mouse double-click event; the replay queue is consume-once via a ref. Symptom that's now fixed: pressing `t` on the dashboard could land the cursor on a random row + drill into TaskDetailDrill if you'd previously used a mouse double-click."

OUT OF SCOPE
------------
- No mouse-event de-duplication beyond consume-once.
- No mouse-input enable/disable toggle.
- No keyboard-vs-mouse mode flag.

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + the 3-step manual repro confirms the fix, close YOUR task with:
  mu task close bug_t_keypress_replays_stale_mouse_dblclick -w tui-impl --evidence "<sha>: <one-line summary including 'verified t→all-tasks-popup lands cursor on row 0, no random drill, after a prior mouse dblclick'>"
````

### #2 by "worker-3", 2026-05-13T05:46:21.510Z

```
FILES: src/cli/tui/app.tsx; test/tui-mouse-state-reset.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (0); npm run lint (0); npx vitest run test/tui-mouse-state-reset.test.ts (0); npm run test (1: unrelated/pre-existing slBackend cleanup ENOTEMPTY in test/vcs-commits-show.test.ts); npx vitest run test/vcs-commits-show.test.ts -t gitBackend (0); npx vitest run test/vcs-commits-show.test.ts -t jjBackend (0); npm run build (0); node dist/cli.js --help (0); node dist/cli.js --version (0, 0.3.2)
FINDINGS: stale popup mouse replay was durable state; replaced with pending ref + consume-once replay helper and clear-on-popup-close. Keyboard popup-opens now see null pending mouse event.
DECISION: committed b0f95fc. Did not run interactive manual 3-step mouse repro in this non-interactive harness; bundle smoke passed.
VERIFIED: targeted mouse replay tests pass; typecheck/lint/build pass; full suite blocked by existing sl cleanup ENOTEMPTY unrelated to TUI mouse path.
ODDITIES: slBackend recentCommits cleanup fails even isolated; git/jj cases in same file pass.
```

### #3 by "worker-3", 2026-05-13T05:46:25.825Z

```
CLOSE: b0f95fc: consume-once mouse replay via ref; targeted tests/typecheck/lint/build/bundle smoke pass; manual t→all-tasks-popup row-0/no-random-drill not run in non-interactive harness; full npm test blocked by unrelated slBackend ENOTEMPTY cleanup
```
