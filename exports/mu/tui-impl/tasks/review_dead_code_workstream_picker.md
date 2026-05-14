---
id: "review_dead_code_workstream_picker"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-12T08:33:23.825Z"
updated_at: "2026-05-12T09:17:10.439Z"
blocked_by: []
blocks: []
---

# REVIEW low: 'w' workstreamPicker binding is a footer-toast placeholder

## Notes (3)

### #1 by "worker-3", 2026-05-12T08:33:24.115Z

```
FILES + LINES:
  - src/cli/tui/keys.ts:74 — input==="w" → {kind:"workstreamPicker"}
  - src/cli/tui/app.tsx:222-226 — case "workstreamPicker": setFooter({command:"workstream picker: v0.next", copied:false}); return;
  - src/cli/tui/help.tsx:43 — HelpRow keys="w" effect="workstream picker (v0.next)"
CATEGORY: dead-code / non-idiomatic
SEVERITY: low
FINDING: Same lie pattern as refresh_now (review_dead_code_refresh_now): a discoverable binding that does nothing useful. The "footer toast says v0.next" thing is a code smell — we're shipping an unimplemented affordance and the toast is the apology. Multi-workstream is now in via Tab/Shift-Tab (feat_tui_multi_workstream), so the picker idea may not even be needed.
SUGGESTED FIX:
  Option A: drop the `w` binding entirely — keys.ts case + app.tsx case + help.tsx row. If picker is ever built, restore.
  Option B: re-purpose `w` to open a workstream picker now that we have multi-ws. Could be a tiny inline strip → `workstreams` array index → setActiveWs.
Whichever, the current "lie + toast" path is the worst of both worlds.
NOTE: tests that pin the binding — tui-keys.test.ts line 95 — should be updated alongside.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:17:02.625Z

```
FILES:
  - src/cli/tui/keys.ts (dropped `w` case + GlobalAction kind + header comment line)
  - src/cli/tui/app.tsx (dropped workstreamPicker switch case + the `input === "w"` arm of the popup-open suppression set)
  - src/cli/tui/help.tsx (dropped HelpRow for `w`)
  - test/tui-keys.test.ts (replaced the workstreamPicker assertion with a regression guard pinning `w` as `noop`)
COMMANDS: typecheck/lint/test/build all clean (exit 0). 1944 tests pass.
FINDING: confirmed the only effect was the v0.next toast; multi-ws Tab/Shift-Tab covers the picker use case.
DECISION: Option A — dropped, not re-purposed. Per the note, the picker idea may not even be needed now that Tab/Shift-Tab is in. If a real picker ever ships, restore the binding then.
NEXT: none.
VERIFIED: tui-keys.test.ts now asserts `dispatchGlobalKey("w", NO_KEY)` returns `{ kind: "noop" }`; confirms regression guard.
ODDITIES: worker-2's review_dedup_popup_useinput touches keys.ts + app.tsx as well (extracts dispatchPopupKeyFromInk). Edits here are at specific switch arms; cherry-pick should auto-merge.
```

### #3 by "worker-3", 2026-05-12T09:17:10.439Z

```
CLOSE: 4a848f89d3eaef31d756a40a62dc4c21639b63a8: dead-code bundle
```
