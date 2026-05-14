---
id: "fix_dag_popup_compact_nodes"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: "worker-3"
created_at: "2026-05-13T05:15:06.716Z"
updated_at: "2026-05-13T05:23:02.926Z"
blocked_by: []
blocks: []
---

# FIX: DAG popup nodes show name+status only (drop t.title aka 'summary line'); truncate (don't wrap) long lines so deep nesting at narrow widths stays single-line per node

## Notes (3)

### #1 by "π - mu", 2026-05-13T05:16:50.137Z

```
MOTIVATION (verbatim user)
--------------------------
"the 'g' Dad panel. only show the task name and status, dont print the clipped contents"
"add a flag or something to disabled it. also, for narrow scrween and deep dag nesting, i still see linewraps in the dag view"
"1/ dot done want to drop the title, we want to drop 'the summary line' after the status."

VOCABULARY (matches user's mental model)
----------------------------------------
- "name" = t.name (the operator-facing slug, e.g. "feat_responsive_layout") — KEEP
- "status" = t.status (OPEN/IN_PROGRESS/CLOSED/REJECTED/DEFERRED) — KEEP
- "summary line" = t.title (the long "FEAT: …" string) — DROP from DAG popup nodes

`mu task tree` CLI verb is OUT OF SCOPE — keep the t.title in static prints. The flag is what makes the two surfaces diverge.

CURRENT STATE
-------------
src/dag.ts line 187:
  function formatTreeNodeLabel(t: TaskRow, statusFn: TaskStatusLabelFn): string {
    return `${t.name}  ${statusFn(t)}  ${t.title}`;
  }

This helper is shared by:
  - src/cli/tasks/tree.ts (mu task tree CLI verb)
  - src/cli/tui/popups/dag.tsx (the DAG popup, opened via `g`)

Both currently render `<name>  <status>  <title>`.

In the DAG popup at typical terminal widths, deep nesting + long titles produces lines that wrap inside the popup borders. The user wants:
1. Drop t.title from the DAG popup nodes.
2. Truncate (not wrap) any remaining long lines so each node stays single-line.

LOCKED DECISIONS
----------------
1. Add a flag/parameter to formatTreeNodeLabel (and renderForest / renderTaskTree by extension):
     formatTreeNodeLabel(t, statusFn, opts?: { includeTitle?: boolean })
   Default: includeTitle=true (back-compat — `mu task tree` CLI behaviour unchanged).
   DAG popup passes includeTitle=false.

2. The DAG popup ALSO truncates each rendered line to the popup's content width so deep nesting at narrow widths doesn't wrap. The truncation happens in dag.tsx, AFTER renderForest emits the lines, by clipping each line to `contentWidthFromCols(cols) - 1` cols (leaving 1 col of safety margin). Use the existing src/cli/tui/columns.ts truncateCell helper if available; otherwise inline a simple wcwidth-aware slice.

WIRING
------
- src/dag.ts:
  * formatTreeNodeLabel: add `opts?: { includeTitle?: boolean }`. Default keeps existing behaviour. When opts.includeTitle === false, return `${t.name}  ${statusFn(t)}` (drop the trailing `  ${t.title}`).
  * renderForest + renderTaskTree: thread the same opts through. Both default to current behaviour.

- src/cli/tui/popups/dag.tsx:
  * Call renderForest(..., { includeTitle: false }) or pass via the existing call site.
  * After receiving the body string (split on 
), apply line-truncation per the popup's actual content width (mirror the DrillScrollView pattern — but DrillScrollView currently wraps; check whether dag.tsx uses DrillScrollView or hand-rolls. Truncation belongs at the dag.tsx layer, NOT inside DrillScrollView, since the user already said wrap-within-borders is the desired behaviour for OTHER drill views — only the DAG popup specifically wants truncate per the deep-nesting concern).

- src/cli/tasks/tree.ts: NO change. Existing call to renderTaskTree continues with the default (includeTitle=true). `mu task tree` keeps printing the long titles.

- DON'T add the truncation knob to the shared formatTreeNodeLabel. Truncation is a render-policy concern of the consumer (terminal width is local to the consumer); the shared helper's job is to format the LOGICAL label, not impose width.

⚠️ COORDINATION ⚠️
- worker-2 is on feat_git_show_drill_color_and_tuicr in PARALLEL.
- Their files: src/vcs.ts + src/cli/tui/popups/drill.tsx + new src/cli/tui/tuicr.ts + src/cli/tui/popups/{commits,workspaces}.tsx + src/cli/tui/keymap-spec.ts + tests.
- Your files: src/dag.ts + src/cli/tui/popups/dag.tsx + tests + maybe src/cli/tui/columns.ts (only if you need to extract a truncate helper).
- ZERO file overlap.

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js`. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

TESTS (REQUIRED)
----------------
- src/dag.ts — extend test/dag.test.ts:
  * formatTreeNodeLabel default behaviour unchanged (3 fields).
  * formatTreeNodeLabel with { includeTitle: false } returns 2 fields (no t.title).
  * renderForest/renderTaskTree threading: when includeTitle=false, NO node line contains any t.title text.
- src/cli/tasks/tree.ts: existing tests must still pass — `mu task tree` CLI still includes title.
- src/cli/tui/popups/dag.tsx — extend test/tui-popup-dag.test.ts:
  * Rendered popup body has NO t.title strings (use a fixture with a recognisable title and assert it's absent).
  * Long lines (longer than the popup's content width) are truncated to ≤ contentWidth chars; not wrapped.
  * Status filter toggles (existing) still work with the new render.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Press 'g' — DAG popup opens.
  # EXPECTED: each node reads "<name>  <status>" only. No "FEAT: …" / "BUG: …" tail.
  # Resize the pane narrow (e.g. 60 cols). Deep-nested branches should still
  # render one line per node (truncated with ellipsis if needed); no wrap.
  # Compare with `mu task tree <id>` in the shell — that should STILL show titles.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke at narrow + wide pane.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap. dag.ts ~200 LOC; dag.tsx ~140 LOC; this is ~30 LOC change.
- Conventional commit prefix: `tui:` (the user-visible change is in the popup; the shared helper picks up the flag).
- Suggested commit:
    tui: DAG popup nodes show name+status only (drop t.title summary); truncate per popup width so deep nesting at narrow widths stays single-line; `mu task tree` CLI keeps titles via the new optional flag default
- Four greens before commit + bundle smoke + manual smoke.

DOCS
----
- CHANGELOG.md [Unreleased] under "Changed":
  * "DAG popup (`g`) nodes now render `<name>  <status>` only — the long task summary trailing each node was clipped or wrapped at narrow widths and added little signal beyond the name. `mu task tree` CLI keeps the full label for static prints. DAG popup also truncates long lines per popup width (no more wrap)."
- docs/USAGE_GUIDE.md: brief note on the DAG popup label format.

OUT OF SCOPE
------------
- No new flag exposed to the CLI (`mu task tree --no-title` is not requested).
- No change to the DAG popup's status filter strip / sort.
- No change to other drill views — they keep wrap-within-borders.

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name> (FRESHLY recreated, at HEAD with everything live).

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual smoke at narrow AND wide pane widths, close YOUR task with:
  mu task close fix_dag_popup_compact_nodes -w tui-impl --evidence "<sha>: <one-line summary including 'verified DAG nodes show name+status only and stay single-line at 60-col pane'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
```

### #2 by "worker-3", 2026-05-13T05:22:56.281Z

```
FILES: src/dag.ts; src/cli/tui/popups/dag.tsx; test/dag.test.ts; test/tui-popup-dag.test.ts; docs/USAGE_GUIDE.md; CHANGELOG.md
COMMANDS: npx vitest run test/dag.test.ts test/tui-popup-dag.test.ts (exit 0); npm run typecheck && npm run lint && npm run test && npm run build (exit 0); node dist/cli.js --help && node dist/cli.js --version (exit 0); tmux manual smoke at 60 cols and 120 cols
FINDINGS: DAG popup shared renderTree label with static mu task tree, so long task titles appeared in the g popup and contributed to narrow-pane wrapping.
DECISION: Added includeTitle option defaulting true in src/dag.ts, passed includeTitle=false only from the DAG popup, and clipped DAG popup body lines after renderForest using contentWidthFromCols(...)-1 via truncateCell.
NEXT: None.
VERIFIED: commit 4414ebf; four greens; bundle smoke; manual TUI smoke confirmed DAG nodes show name+status only and stay single-line at 60-col pane and also at a wider 120-col pane.
ODDITIES: DrillScrollView intentionally wraps other drill views, so DAG-specific truncation stays local to dag.tsx.
```

### #3 by "worker-3", 2026-05-13T05:23:02.926Z

```
CLOSE: 4414ebf: compact DAG popup nodes; verified DAG nodes show name+status only and stay single-line at 60-col pane
```
