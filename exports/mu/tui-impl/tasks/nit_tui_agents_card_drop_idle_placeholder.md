---
id: "nit_tui_agents_card_drop_idle_placeholder"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-11T16:48:09.347Z"
updated_at: "2026-05-11T19:00:01.976Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# NIT: Agents card — drop the '—' idle placeholder; only render '⚠ idle' when actually idle (lazygit/k9s convention: render exceptions, hide non-exceptions)

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:48:37.436Z

```
GOAL
----
Remove the literal '—' (em-dash) placeholder from the Agents card's
idle column. Only render '⚠ idle' (yellow) when an agent is actually
idle past the threshold; render the empty string otherwise.

WHY
---
User report: looking at a healthy crew, every row carries a trailing
'—' that doesn't visually mean anything (it's the "not idle"
sentinel). It looks like a missing value, an out-of-place separator,
or — once feat_tui_multi_workstream lands with tabs — the user
mentally asks "is that going to be the workstream column?".

It's neither. It's a column placeholder doing zero work.

lazygit / k9s / btop convention: render exceptions, hide
non-exceptions. The signal lives in `⚠ idle`; the placeholder is
information-free 95% of the time and visually noisy 100% of the
time.

LINE-PRECISE EDIT
-----------------
src/cli/tui/cards/agents.tsx:64

  -   const idle = a.idle ? "⚠ idle" : "—";
  +   const idle = a.idle ? "⚠ idle" : "";

The COLUMN_SPECS entry for the idle column is `{ kind: "protect" }`
which means columns.ts will pad the empty string to the column's
natural width — so visually the column collapses to whitespace when
nobody is idle, and the '⚠ idle' token still aligns with the few
idle rows.

CAVEAT — column survives when ANY row is idle
---------------------------------------------
Because columns.ts computes natural width across ALL rows, the
column width = max('⚠ idle'.length, '') = 6 cols whenever at least
one agent is idle in the visible set. The non-idle rows render 6
spaces of trailing whitespace (which ink's <Text> trims at the
right edge anyway in typical terminals — and the rounded right
border is the visual anchor regardless). When EVERY agent is healthy,
the column collapses to 0 cols and the row reads:

  ⚙   worker-1   <task-bit>
  ⚙   worker-2   <task-bit>

…which is the desired clean state.

PARALLEL — DON'T REPURPOSE THE COLUMN
-------------------------------------
Do NOT replace '—' with a workstream-name placeholder in
anticipation of feat_tui_multi_workstream. That feature ships
TABS (option B per its notes) — one workstream visible at a time —
so per-row ws identity is encoded by the active tab, not by a
column. A per-row ws column would be 100% redundant within a tab
view. (See the cross-ref note added to feat_tui_multi_workstream
in the same change wave.)

TESTS
-----
- test/tui-card-agents.test.ts: extend the populated-snapshot smoke
  case to assert the source no longer contains the literal `: "—"`
  ternary branch. Crude regex match.
- Rendering test: ink-testing-library is not available, so a
  static-source assertion that line 64 reads `: "";` is the cheapest
  regression guard.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: Agents card — drop '—' idle placeholder; render only '⚠ idle'
         on actually-idle agents (signal lives in the exception)

OUT OF SCOPE
------------
- Don't change the '⚠ idle' rendering itself (yellow + 'idle' text
  is fine; matches the rest of the TUI's exception colour).
- Don't change the column-spec for idle (still PROTECTED — when it
  IS rendered, '⚠ idle' should never clip).
- Don't audit other cards for similar placeholders unless you
  spot one — file a follow-up nit.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close nit_tui_agents_card_drop_idle_placeholder -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-11T19:00:01.976Z

```
CLOSE: 10fcc1c — drop em-dash idle placeholder in cards/agents.tsx (one-line edit + regression-guard test)
```
