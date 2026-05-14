---
id: "bug_tui_flicker_on_every_tick"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.2
roi: 400.00
owner: null
created_at: "2026-05-11T16:52:46.935Z"
updated_at: "2026-05-11T17:12:24.402Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: TUI flickers on every tick — full re-render even when snapshot unchanged (and wrapped rows make it worse)

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:53:39.543Z

```
SYMPTOM (verbatim user repro)
-----------------------------
\"busy --tuis flicker on every update, might we wrapping lines?\"

Two compounding effects make the flicker visible:

1. The ENTIRE dashboard frame is repainted on every poll tick (1s
   default). With 9 cards + status bar + ~30 visible rows that's a
   perceptible flash even when nothing changed.

2. Long titles (esp. in the Ready card) wrap to two terminal lines
   because layoutColumns() is called without totalWidth — see
   sibling bug_tui_long_lines_overflow. Each wrapped row doubles
   the painted area, making the flicker more noticeable.

Both fixes ship independently but compound visually. This task is
about (1) — the unconditional re-render. (2) is bug_tui_long_lines_overflow.

ROOT CAUSE — full re-render on every tick
-----------------------------------------
src/cli/tui/state.ts useDashboardSnapshot() unconditionally calls

    setSnap({ data, lastTickMs: dur, error: null });

on every successful tick. React/ink's reconciler sees a new top-
level state object reference → re-renders <App> → re-renders every
card + popup branch + status bar → ink writes the whole frame to
the terminal even when nothing visible changed.

ink IS diff-aware on its OWN tree (it only repaints lines that
changed since the last render), BUT every render is a SEPARATE
input to the diff — and because two adjacent ticks produce two
NEW WorkstreamSnapshot objects (loadWorkstreamSnapshot allocates a
fresh shape each call), every primitive prop down the tree (rows
arrays, view.agents arrays, etc.) is a NEW reference too. ink's
diff is reference-based for arrays/objects, value-based for
strings/numbers. So when the TEXT didn't change but the ARRAY
reference did, ink still re-renders the children to compare.

The lastTickMs field changes EVERY tick (it's the measured fetch
duration in ms). That alone forces a state change. Even with
data-unchanged short-circuiting, lastTickMs would still trigger
a re-render — and lastTickMs is only used to display the tick rate
in the StatusBar's RIGHT zone (the dim "1s" indicator).

FIX — three layers
------------------

LAYER A — DON'T set state when data is byte-equal AND error is
unchanged.

In src/cli/tui/state.ts useDashboardSnapshot(), add a stable
JSON-stringify shallow comparison guard:

    const dataKey = data === null ? \"\" : JSON.stringify(snapshotKey(data));
    setSnap((prev) => {
      const prevKey = prev.data === null ? \"\" : JSON.stringify(snapshotKey(prev.data));
      if (prevKey === dataKey && prev.error === null) {
        // data unchanged — DO NOT re-render. (lastTickMs is allowed
        // to drift; it's only used in the dim RIGHT zone of the
        // StatusBar and a 1-frame stale value is invisible.)
        return prev;
      }
      return { data, lastTickMs: dur, error: null };
    });

snapshotKey(data) is a pure helper that picks ONLY the fields that
should trigger a re-render — agents, ready, inProgress, blocked,
recentClosed, tracks, recent (events), workspaces, doctor. Skip
fields that don't affect the visible frame (e.g. internal cache
metadata, if any).

JSON.stringify on a snapshot that's ~100KB is ~1ms — negligible
vs the 1s tick.

LAYER B — DECOUPLE lastTickMs from the data state.

Move the tick-rate display state into a SEPARATE useState in
useDashboardSnapshot(), and update IT every tick unconditionally.
Then return BOTH from the hook:

    const [data, setData] = useState<{snapshot|null,error}>(...);
    const [lastTickMs, setLastTickMs] = useState(0);

setLastTickMs(dur) on every tick → only the StatusBar re-renders
when its tick prop changes. setData runs through Layer A's guard
→ no card re-render when data unchanged.

ink's reconciler will isolate each child to its own re-render
tree as long as the changed prop is below the App root. Verify by
giving lastTickMs to <StatusBar> as a SEPARATE prop, NOT bundled
in the snapshot.

LAYER C — MEMOISE expensive card children.

Each card's body computation (layoutColumns + rows + renderRow)
runs on every render even when its input data is identical. Wrap
each card body with React.memo OR useMemo on the expensive bits:

    const widths = useMemo(() => layoutColumns(rows, COLUMN_SPECS, contentWidth), [rows, contentWidth]);

After Layer A this is mostly belt-and-braces (data won't change
mid-tick) but it future-proofs against any non-data state changes
(card visibility toggles, popup open/close, tick-rate adjust).

BUDGET
------
Three layers. Layer A alone should kill ~95% of the flicker. Layer
B is needed to prevent the StatusBar's tick-ms display from
re-rendering the whole dashboard. Layer C is optional polish; ship
it ONLY if the perf measurement after A+B still shows visible
flicker.

VERIFY
------
1. npm run build && node dist/cli.js state --tui -w <ws>
2. Stare at a STABLE workstream (no agents busy). The dashboard
   should be visually static between ticks. The tick-rate indicator
   in the bottom-right (\"1s\") may still tick — that's a 1-row,
   3-column update; ink should diff it down to ~3 cols of repaint.
3. Trigger a real change (e.g. mu task close X -w <ws> from a
   sibling shell). Watch the dashboard repaint that ONE row.
4. Compare with --tui pre-fix: full-frame flash on every tick.

INSTRUMENTATION (optional)
-------------------------
For verification: add a temporary `console.error('App render', i++)`
inside the App body, run for 10s, count. Pre-fix: ~10 (one per tick).
Post-Layer-A: ~0 (only on real data change). Drop the instrumentation
before commit.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: dashboard only re-renders on actual data change
         (Layer A snapshot key + Layer B decoupled tick-ms state)

DOCS
----
- CHANGELOG.md (under v0.4.0): bullet under TUI bugs fixed.
- docs/ARCHITECTURE.md src/cli/tui/state.ts cell: mention the
  re-render guard.

TESTS
-----
- New test/tui-state-hook-rerender.test.ts: pure-function tests for
  snapshotKey() — assert it picks the visible-affecting fields and
  IGNORES fields like internal timestamps; assert two different
  snapshots with the SAME visible data produce the SAME key
  (regression guard against accidentally including non-visual
  fields).

- Hard to test useDashboardSnapshot directly without ink-testing-
  library. Static-source assertion is adequate: assert that
  src/cli/tui/state.ts contains the words `snapshotKey`, the prev
  comparison block (regex `prevKey === ` AND `return prev`), and
  that lastTickMs is in a separate useState (regex `useState\(0\)`
  near a `setLastTickMs` call).

OUT OF SCOPE
------------
- Don't fix the wrapping bug here — sibling bug_tui_long_lines_overflow.
  When BOTH land, the visual quality jumps significantly.
- Don't add a config knob for the flicker behaviour (no config
  file pledge).
- Don't reduce the default tick rate (1s is the right default for a
  task-DAG dashboard; the cause is unconditional repaint, not the
  tick rate itself).
- Don't memoise individual card LIST ITEMS (Layer C is at the card
  body level, not row level — premature otherwise).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_flicker_on_every_tick -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-11T17:12:24.402Z

```
CLOSE: 0940a5c — Layer A snapshotKey-guarded setData (returns same 'data' ref across no-op ticks) + Layer B lastTickMs in own useState; src/cli/tui/state.ts only; new test/tui-state-hook-rerender.test.ts (15 cases); CHANGELOG + ARCHITECTURE updated; 4 greens (typecheck, lint, 1587 tests, build)
```
