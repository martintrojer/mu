---
id: "review_dedup_popup_shell"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.1
roi: 550.00
owner: "worker-2"
created_at: "2026-05-12T08:30:57.321Z"
updated_at: "2026-05-12T08:55:40.952Z"
blocked_by: []
blocks: []
---

# REVIEW med: Centralise popup Shell function (8 byte-identical copies)

## Notes (3)

### #1 by "worker-3", 2026-05-12T08:31:08.065Z

```
FILES: src/cli/tui/popups/{agents,blocked,doctor,inprogress,log,recent,tracks,workspaces}.tsx (Shell function at the bottom) + popups/ready.tsx (PopupShell with the same shape).
CATEGORY: duplication
SEVERITY: med
FINDING: Eight popups define a byte-identical local `function Shell({title,hint,children})` that wraps <TitledBox borderColor="cyan" titleColor="cyan" bottomLabel={hint} flexGrow={1}>. ready.tsx has the same component under the name `PopupShell` (only difference: hint allows null). 8 verbatim copies + 1 near-copy = 9 places to update if the popup chrome ever changes.
SUGGESTED FIX: extract `src/cli/tui/popup-shell.tsx` exporting `PopupShell({title, hint, children})`. Replace the 8 local `function Shell(...)` definitions and ready.tsx's PopupShell with the single import. tui-popup-shells.test.ts already centralised the assertions; switch them to assert imports of the shared component. Estimated diff: -120 LOC, +30 LOC.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-2", 2026-05-12T08:55:40.681Z

```
FILES: src/cli/tui/popup-shell.tsx; src/cli/tui/popups/{agents,blocked,doctor,inprogress,log,ready,recent,tracks,workspaces}.tsx; test/tui-popup-shells.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (0); npm run lint (0 after formatting tracks PopupShell title); npm run test (0); npm run build (0); git commit 9e60d21
FINDINGS: 8 popups had duplicated local Shell wrappers and ready.tsx had a near-identical PopupShell.
DECISION: extracted a shared PopupShell with nullable hint mapping and replaced all 9 popup-local shell definitions with imports.
VERIFIED: typecheck, lint, full test suite, and build all passed.
ODDITIES: none
```

### #3 by "worker-2", 2026-05-12T08:55:40.952Z

```
CLOSE: 9e60d21: extracted PopupShell, 9 popups migrated
```
