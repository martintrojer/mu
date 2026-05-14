---
id: "review_dedup_popup_useinput"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-2"
created_at: "2026-05-12T08:31:12.218Z"
updated_at: "2026-05-12T09:10:28.095Z"
blocked_by: []
blocks: []
---

# REVIEW med: Extract dispatchPopupKey wrapper to drop 9× useInput key-flag boilerplate

## Notes (3)

### #1 by "worker-3", 2026-05-12T08:31:22.869Z

```
FILES: src/cli/tui/popups/{agents,blocked,doctor,inprogress,log,ready,recent,tracks,workspaces}.tsx — every popup has the same 13-line block:
    const action = dispatchPopupKey(input, {
      ctrl: key.ctrl, shift: key.shift, meta: key.meta,
      escape: key.escape, return: key.return,
      upArrow: key.upArrow, downArrow: key.downArrow,
      leftArrow: key.leftArrow, rightArrow: key.rightArrow,
      tab: key.tab, pageUp: key.pageUp, pageDown: key.pageDown,
    });
CATEGORY: duplication
SEVERITY: med
FINDING: 9 copies × 13 LOC = ~117 lines that just re-pack ink's `Key` into our local `KeyFlags` shape and call dispatchPopupKey. New popups that forget one field (e.g. `pageUp`) silently lose the binding.
SUGGESTED FIX: add `dispatchPopupKeyFromInk(input, key)` to src/cli/tui/keys.ts that does the explicit pick (or accept ink's Key directly via structural typing — KeyFlags is already a subset). Replace every `useInput((input, key) => { ... const action = dispatchPopupKey(...) ... })` callsite with `const action = dispatchPopupKeyFromInk(input, key);`. Same trick applies to dispatchGlobalKey in app.tsx.
NOTE: Same anti-drift argument as feat_centralize_scroll_navigation — the value of the centralisation is "you can't forget a field on the next popup".
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-2", 2026-05-12T09:10:25.392Z

```
FILES: src/cli/tui/keys.ts; src/cli/tui/app.tsx; src/cli/tui/popups/{agents,blocked,doctor,inprogress,log,ready,recent,tracks,workspaces}.tsx; test/tui-keys.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test (exit 0; 117 files / 1906 tests); npm run build (exit 0); git commit (de91a30)
FINDINGS: All popup useInput handlers repeated the ink Key -> KeyFlags object literal; App did the same for global keys.
DECISION: Added dispatchPopupKeyFromInk and dispatchGlobalKeyFromInk in keys.ts, keeping the explicit pick in the pure keymap module without importing ink. Migrated all 9 popups and App to call the wrappers.
NEXT: None.
VERIFIED: Four greens passed locally.
ODDITIES: Unit tests cover wrapper normalization for F5, Tab/Shift-Tab, Escape, PgDn, and Ctrl-D.
```

### #3 by "worker-2", 2026-05-12T09:10:28.095Z

```
CLOSE: de91a30: extracted dispatchPopupKeyFromInk; 9 popups migrated
```
