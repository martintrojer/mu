---
id: "fix_help_overlay_render_single_column"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-2"
created_at: "2026-05-12T19:55:40.576Z"
updated_at: "2026-05-12T21:00:47.170Z"
blocked_by: ["bug_all_tasks_popup_no_scroll"]
blocks: []
---

# FIX: '?' help overlay renders as 5+ side-by-side cards = long thin strips of squished text; switch to a single vertical-column list with bold section headers

## Notes (3)

### #1 by "π - mu", 2026-05-12T19:56:33.110Z

```
MOTIVATION (verbatim user)
--------------------------
"the new help renders quite odd. long strips per group. would be better with just a simple list view with headers."

CURRENT STATE
-------------
After commit 1d923e3 (audit_status_bar_hint_consistency), src/cli/tui/help.tsx renders the help overlay as a horizontal row of 5+ rounded boxes:

  flexDirection="row" gap={2}
    └─ Box (rounded, "keys · dashboard")    ← long thin column
    └─ Box (rounded, "keys · popup list")
    └─ Box (rounded, "keys · popup drill")
    └─ Box (rounded, "keys · popup filter")
    └─ Box (rounded, "keys · DAG / all-tasks")
    └─ Box (rounded, "mouse")

Each pane is sized by content, gets a border, paddingX=1, AND is squeezed into a horizontal column. On a typical terminal width (120-160 cols), the 6 boxes leave only ~20 cols per pane for the effect text — which then wraps inside its own narrow border, producing the "long thin strip" look the user described.

The PRE-1d923e3 design (2 panes) worked because there were ONLY two panes; the audit grew that to 6 without revisiting the layout.

DESIRED LAYOUT (locked)
-----------------------
Single vertical list:
- Outer rounded box (one border, not six).
- Inside: section headers (bold cyan, e.g. "keys · dashboard") followed by the rows for that section.
- Blank line between sections (visual separator).
- The full overlay reads top-to-bottom like a man page; no horizontal squishing.

Concretely:

  ╭─ keys ───────────────────────────────────────────────────────────╮
  │ keys · dashboard                                                  │
  │   0-9               toggle Commits/Agents/Tracks/.../Doctor       │
  │   Shift 0-9         open numbered popups (Shift+0 = Commits)      │
  │   g                 DAG popup                                     │
  │   t                 all-tasks popup                               │
  │   …                                                               │
  │                                                                   │
  │ keys · popup list                                                 │
  │   j/k or ↑/↓        move selection                                │
  │   …                                                               │
  │                                                                   │
  │ mouse                                                             │
  │   double-click card  drill into popup                             │
  │   …                                                               │
  ╰───────────────────────────────────────────────────────────────────╯

WIRING
------
- src/cli/tui/help.tsx Help() function: replace the `<Box flexDirection="row" gap={2}>{HELP_PANES.map(pane => <Box border>...)}</Box>` with:

    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      {HELP_PANES.map((pane, paneIdx) => (
        <Box key={pane.title} flexDirection="column">
          {paneIdx > 0 && <Text> </Text>}  {/* blank-line separator */}
          <Text bold color="cyan">{pane.title}</Text>
          {pane.rows.map(row => (
            <HelpRow key={`${pane.title}:${row.keys}`} keys={row.keys} effect={row.effect} />
          ))}
        </Box>
      ))}
    </Box>

- HelpRow stays as it is (Box width=18 + dim effect text). The outer column now gives it the full pane width.

- Optional: inflate the per-row keys-column width slightly (e.g. 20 → 22) since the new layout has more horizontal real estate. Verify against the longest key string in HELP_PANES — "Tab / Shift-Tab" is 15 chars; current width=18 already covers it.

⚠️ KEEP keymap-spec.ts UNCHANGED ⚠️
The audit task created src/cli/tui/keymap-spec.ts as the single source of truth for both Help() and buildHints(). Don't touch it. Only the LAYOUT in help.tsx changes; the data and the orphan-hint regression test stay correct by construction.

⚠️ COORDINATION ⚠️
Gated behind bug_all_tasks_popup_no_scroll (worker-2 in flight). Once that lands, this can dispatch.

TESTS (REQUIRED)
----------------
- test/tui-help-overlay.test.ts: extend with:
  * Assert the rendered overlay is a SINGLE outer Box with rounded border (not multiple side-by-side boxes). Walk the JSX tree and assert there's exactly one borderStyle="round" Box at the top level.
  * Assert section headers ("keys · dashboard", "keys · popup list", "mouse", etc) all appear in bold cyan.
  * Assert blank-line separators between sections (one `<Text> </Text>` between each pane).
  * Existing assertions (mouse bindings present, no v0.next, etc) all still pass.
- test/tui-keymap-consistency.test.ts: NO changes — invariant unaffected.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # press '?' — overlay should be a single column list with bold section
  # headers, no horizontal squishing, all rows readable on a 120-col pane.
  # press '?' again to dismiss.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; help.tsx is ~25 LOC; this is a ~10 LOC change.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: '?' help overlay renders as one vertical column with section headers (was: 6 side-by-side rounded boxes squishing every effect string)
- Four greens before commit + bundle smoke.

DOCS
----
- CHANGELOG.md [Unreleased] under "Changed":
  * "TUI '?' help overlay re-rendered as a single vertical column with bold section headers (was: 6 side-by-side rounded boxes that squished every effect string into a long thin strip on typical terminal widths)."

OUT OF SCOPE
------------
- No new help content (additions/removals belong in the audit task, not here).
- No tab-pagination of the help overlay (the man-page scroll feel is the goal — if it ever overflows the terminal vertically, that's a future improvement).
- No keymap data restructure.
- No mouse bindings change.

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name> (FRESHLY recreated, at HEAD with everything shipped this session).

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual smoke, close YOUR task with:
  mu task close fix_help_overlay_render_single_column -w tui-impl --evidence "<sha>: <one-line summary including 'verified single-column overlay readable at 120 cols'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
```

### #2 by "worker-2", 2026-05-12T21:00:42.023Z

```
FILES: src/cli/tui/help.tsx; test/tui-help-overlay.test.ts; CHANGELOG.md
COMMANDS: npx vitest run test/tui-help-overlay.test.ts test/tui-keymap-consistency.test.ts (exit 0); npx biome check --write src test (exit 0, formatter only); npm run typecheck && npm run lint && npm run test && npm run build (exit 0); node dist/cli.js --help (exit 0); tmux manual smoke at 120x60 with node dist/cli.js -w tui-impl then '?' (exit 0 / visual capture)
FINDINGS: Previous help layout used one rounded box per HELP_PANES section in a horizontal row, causing narrow wrapped columns.
DECISION: Kept keymap-spec.ts unchanged and changed only Help() layout to one outer rounded cyan Box, vertical section headers, and blank-line separators. Added width pins so Ink does not leave stale row fragments in 120-col smoke.
NEXT: None.
VERIFIED: Four greens; bundle smoke; manual smoke verified single-column overlay readable at 120 cols.
ODDITIES: 120x45 capture clips lower rows because App help frame has no vertical scrolling; 120x60 shows the full man-page list cleanly.
```

### #3 by "worker-2", 2026-05-12T21:00:47.170Z

```
CLOSE: 1f61fc2: rendered '?' help as one vertical column with bold cyan section headers; four greens, bundle smoke, and verified single-column overlay readable at 120 cols
```
