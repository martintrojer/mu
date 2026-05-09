---
id: "nit_hud_render_tables"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-08T13:13:54.970Z"
updated_at: "2026-05-08T14:43:51.055Z"
blocked_by: []
blocks: []
---

# NIT: mu hud renders agents/ready/in-progress as text lines; consider cli-table3 like mu state does

## Notes (3)

### #1 by π - mu, 2026-05-08T13:13:55.098Z

```
SURFACED LIVE during snap_schema dispatch.

CURRENT (mu hud --mid):
  mu-roadmap-v0-2 · 0 ready · 1 in-progress · 2 tracks
  agents (3 active):
    💤 code-reviewer-1 · - +1h
    💤 test-reviewer-1 · - +1h
    ⚙️ worker-1 · snap_schema +0s
  in-progress (1):
    snap_schema  Impl: snapshots table + auto-snapshot h… · ROI 160 (→ worker-1)

WHAT'S OFF:
- the agent block is bullet-list-ish but the columns drift (' · ' is a soft separator; long task ids push '+T' off the right edge).
- the ready/in-progress block uses ' · ' the same way and truncates titles silently to ~40 chars.
- compare with mu state (formatAgentsTable, formatTaskListTable) which use cli-table3 — proper bordered columns, per-column padding, no drift.
- in --full mode the tracks list IS already a bullet list (no table needed for tracks because the diamond-merge is the headline; columns wouldn't help).

PROPOSAL:
- formatHudAgentLines and formatHudTaskLines render via cli-table3 (with style:{head:[]} like the existing mu state tables).
- agent table cols: emoji | name | task | +ago. Right-align ago.
- ready table cols: id | title | ROI. Truncate title via the existing 40-char cap but inside the table cell.
- in-progress table cols: id | title | ROI | owner.
- --line / --small unchanged (one-liner / counts-only have no table to render).

NICE-TO-HAVE:
- omit the 'agents (N active)' / 'ready (N)' header strings if the table itself shows the count via row count (saves vertical space).
- 'on a busy workstream the table widths should add up sensibly' — should be verified by snapshot test against a 5-agent / 8-ready fixture.

ESTIMATE: ~30 LOC + 2 snapshot tests. Promotion criterion: trivially small, tractable, makes the verb feel like a peer of mu state. Filed during the snap dispatch hand-off.
```

### #2 by π - mu, 2026-05-08T13:14:21.395Z

```
ADDITION: dynamic width.

The HUD often runs inside a tmux pane (popup / split). Width varies — the operator could be on a 220-col laptop screen, a 80-col tmux split, or a 50-col mobile attach. Tables should respect the terminal width:

- detect the available width via process.stdout.columns (already used by other tools); fall back to 80 when undefined (non-TTY / pipe).
- size each table cell to fit: left-align id/name, right-align ROI/+ago, GROW the title column to absorb extra width up to a sensible cap.
- truncate the title (or whatever is the most compressible cell) with '…' rather than overflowing or wrapping. Truncation length should be: total_width - sum(other_cols) - separator_overhead.
- on very narrow terminals (<60 cols) consider degrading to the --small mode automatically, or just dropping the title column entirely.

This matters more for --full (which has tracks list + recent events too) where overflow gets ugly fast.

cli-table3 supports `colWidths: [N, N, ...]` and `wordWrap: false`. The dynamic part lives in the renderer (compute widths from terminalWidth - fixedCols - separatorOverhead, then pass to colWidths).

Same constraint applies to the existing mu state tables — they currently overflow on narrow terminals — so the helper, once built, could be reused there.
```

### #3 by π - mu, 2026-05-08T14:43:50.957Z

```
FILES: src/cli.ts (cmdHud + 4 new format helpers + hudPaneSize + tableLineCost/maxRowsForLineBudget); src/tmux.ts (new currentPaneSize export); test/hud.test.ts (rewritten: 7 cases); CHANGELOG.md (Breaking + Added under [Unreleased]); README.md + skills/mu/SKILL.md (verb line).
COMMANDS: typecheck/lint/test/build all green; live smoke at 60x10, 60x40, 80x12, 140x40 + the auto-detected TTY size.
DECISION: dropped --line/--small/--mid/--full per orchestrator brief; kept --json (machine surface; same shape unchanged) and -n (tail cap, default raised 5->10). Pane size via TTY > tmux #{pane_width}x#{pane_height} > 120x30 fallback; MU_HUD_FORCE_SIZE env override for tests + operator escape hatch.
NEXT: status-bar / dotfile callers using `mu hud --line` will break; documented under Breaking. mu hud --json | jq is the script-friendly substitute.
VERIFIED: 702/702 tests; all 4 sections render correctly across 4 forced sizes; +N more footer fires at 60x10 with the discoverability verb interpolated; --json shape preserved (existing snapshot test in suite + new explicit shape assertion).
SHIPPED: commit 441d21e on main.
```
