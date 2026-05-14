---
id: "bug_tui_tab_switch_stale_render"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.2
roi: 375.00
owner: null
created_at: "2026-05-12T05:13:45.758Z"
updated_at: "2026-05-12T06:10:18.393Z"
blocked_by: []
blocks: ["review_tui_code_and_tests", "t41_manual_smoke"]
---

# BUG: Tab to switch workstream shows OLD ws's cards under NEW ws's tab — render lags one tick + may NEVER update if snapshotKey collides between empty-ish wss

## Notes (4)

### #1 by "π - mu", 2026-05-12T05:14:53.101Z

```
SYMPTOM (verbatim user repro)
-----------------------------
User runs `mu state --tui -w tui-impl,gchatui` (the multi-ws Tab
feature shipped in feat_tui_multi_workstream commit d0266a3).
Initial frame shows tui-impl correctly. Press Tab → tab strip
flips to gchatui (highlight moves), but the cards render a MIXED
frame:

  ╭─ ¹ Agents ───────────────────...─╮
  │ worker-1  —                   │   ← these are tui-impl's agents
  │ worker-2  —                   │
  ╰────────────────────────────── ╯
  ╭─ ² Tracks ─────────...───────────╮
  │ (no goals) try `mu task add -w gchatui --title \"...\"` │   ← gchatui (right)
  ╰─────────────────────────────────╯
  ╭─ ³ Ready ──────...───────────────╮
  │ (no ready tasks) every blocker is OPEN/IN_PROGRESS or every task is closed │   ← gchatui (right)
  ╰─────────────────────────────────╯
  ╭─ ⁴ Activity log · last ↑8 ──────╮
  │ 14:33:10 worker-1  task.claim cfp_c_messageview_per_row_diff... │   ← gchatui events
  ...

Mixed frame: Agents card shows the OLD workstream's agents while
the rest of the dashboard shows the NEW workstream. The Agents
card may NEVER update to gchatui's agents (no agents) for as long
as the popup state allows.

ROOT CAUSE — TWO COMPOUNDING BUGS
---------------------------------

(1) STALE DATA SHOWN BETWEEN TICKS.

src/cli/tui/state.ts useDashboardSnapshot's useEffect depends on
`workstream`. When workstream changes (Tab fires setActiveWs),
React tears down the old effect and schedules a new one. But the
hook still has the OLD `data` in useState until the NEW effect's
first tick resolves (asynchronous, ~10-50ms for the SQLite read).

In the gap, `snap.data` is the OLD workstream's WorkstreamSnapshot.
Cards render against it. The result is a frame whose CARDS are
old-data but whose TAB STRIP is new-data — exactly the user's
screenshot.

(2) snapshotKey() COLLIDES BETWEEN EMPTY-ISH WORKSTREAMS,
    SUPPRESSING THE REFRESH.

The flicker fix from bug_tui_flicker_on_every_tick added a re-render
guard at src/cli/tui/state.ts:138-145:

    setData((prev) => {
      const prevKey = prev.data === null ? \"\" : snapshotKeyString(prev.data);
      if (prev.error === null && prevKey === freshKey) {
        // Visible content unchanged — return the SAME object reference
        return prev;
      }
      return { data: fresh, error: null };
    });

snapshotKey() (state.ts:207) projects ONLY the visible-affecting
fields. Inspect: does it include `workstreamName`?

    export function snapshotKey(s: WorkstreamSnapshot): unknown {
      return {
        workstreamName: s.workstreamName,   // ← YES
        ...
      };
    }

OK so workstreamName IS in the key. So workstreams with different
names produce different keys. Good.

BUT: the Agents card in the user's repro is showing tui-impl's
worker-1 + worker-2 (two real agents) UNDER the gchatui tab. If
the tick had run and snapshotKey had been compared, the new key
would include `workstreamName: \"gchatui\"` ≠ \"tui-impl\" so the
guard would fire — BUT the new tick's first call is `void tick()`
(line 156, immediately after setInterval is set up). That call
DOES happen but the first frame between Tab-press and tick-resolve
shows OLD data because React already re-rendered <App> with the
new workstream prop value, and useDashboardSnapshot returns
{data: <old>, ...} (its useState hasn't been touched yet).

So bug (2) doesn't actually fire — the issue is purely (1): the
hook can't show NEW data faster than it can fetch. We need to
either:
  - clear data to null while waiting (showing empty cards briefly), OR
  - block rendering of stale data when the data's workstreamName
    doesn't match the requested workstream.

Note: bug (2) MIGHT still fire when both workstreams happen to
have IDENTICAL visible content. Verify by Tab-switching between
two empty workstreams; if cards never refresh to the new ws, the
guard is also at fault. Defensive fix: include `workstream` in the
useEffect-key OR explicitly drop the snapshot to null when
workstream changes.

FIX
---

OPTION A (recommended) — DISCARD STALE DATA ON WORKSTREAM CHANGE.

Add a useEffect that fires when `workstream` changes, resetting
data to null (or to a sentinel snapshot whose workstreamName
matches the new ws but rest is empty):

    // Drop stale snapshot the moment the workstream prop changes —
    // the next tick will populate fresh data for the new ws. Without
    // this, cards render the OLD ws's data under the NEW ws's tab.
    const lastWsRef = useRef(workstream);
    if (lastWsRef.current !== workstream) {
      lastWsRef.current = workstream;
      // Synchronous reset — avoids a render of stale data.
      setData({ data: null, error: null });
    }

Cards already handle `snapshot === null` (the loading… state).

OPTION B — SUPPRESS RENDER WHEN snapshot.workstreamName !==
expected workstream.

Cleaner: cards filter on workstreamName mismatch. But every card
would need this check; harder to maintain than a single hook-level
reset.

OPTION C — synchronous read on workstream change.

loadWorkstreamSnapshot is async. Even if it weren't, calling it
synchronously in render is a React anti-pattern. Skip.

→ Recommend OPTION A.

LINE-PRECISE EDIT
-----------------
src/cli/tui/state.ts in useDashboardSnapshot:

  +  const lastWsRef = useRef(workstream);
  +  if (lastWsRef.current !== workstream) {
  +    lastWsRef.current = workstream;
  +    setData({ data: null, error: null });
  +    setLastTickMs(0);
  +  }
     useEffect(() => {
       if (!enabled) return;
       ...

Add `useRef` to the imports from \"react\" (already imports
useEffect, useState).

VERIFY
------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl,gchatui
3. Press Tab. Cards should immediately render \"loading…\" /
   empty-state messages for the gchatui content.
4. Within ~tickMs (1s default), all cards populate gchatui's data.
5. No mixed frame — Agents card empty (gchatui has no agents)
   simultaneously with empty Ready / empty Tracks.
6. Press Tab again. Same flow back to tui-impl.

EDGE CASES
----------
- Rapid Tab presses: each transition resets data; tick eventually
  catches up. No race because setData with the same null is a no-op
  for ink (Object.is(prev, prev) === true).
- snapshotKey collision (bug 2 hypothetical): with OPTION A, the
  prev data is null → snapshotKey check sees prev.data === null
  → falls through to setData({data: fresh}), so collision can't
  cause a stuck-on-old-ws state.

TESTS
-----
- New test/tui-multi-ws-tab-switch.test.ts: pure-source assertion
  that useDashboardSnapshot has a workstream-change-discards-stale
  branch (regex match for `lastWsRef` + `setData.*null`).
- Or: refactor the discard logic into a pure helper
  `shouldDiscardForWorkstream(prevWs, newWs)` and unit-test that.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (state.ts is ~280 LOC; +5).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: discard stale snapshot on Tab/workstream-switch (was
         showing OLD ws's cards under NEW ws's tab for ~tickMs)

DOCS
----
- CHANGELOG.md (under v0.4.0): bullet under TUI bugs fixed.

OUT OF SCOPE
------------
- Don't change the snapshotKey() shape — workstreamName is already
  in there.
- Don't change the Tab/Shift-Tab keymap (it's correct; the bug is
  purely the render lag).
- Don't add a loading spinner (cards already show \"loading…\" on
  null snapshot per Card 1's empty-state path).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_tab_switch_stale_render -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "π - mu", 2026-05-12T05:16:39.349Z

```
ESCALATION (2026-05-11) — REPRO IS WORSE THAN \"Tab is laggy\"
------------------------------------------------------------
User retried with NO Tab pressed, just direct launch into a single
workstream:

    mu state --tui -w gchatui

…and got a BROKEN Agents card immediately on first render:

  ╭─ ¹ Agents · 2 alive · 0 idle ─────────────────────...─╮
  │ ⚙ worker-1  —    ← this row: NO task summary at all (column gone)
  │ ⚙ worker-2  —    ← same
  ╰────────────────────────────────────────────────────...╯
  ╭─ ² Tracks ──────────────────────────────────────...─╮
  │ (no goals) try \`mu task add -w gchatui --title \"...\"\` │   ← gchatui correct
  ╰────────────────────────────────────────────────────╯
  ╭─ ³ Ready ──────────────────────────────────────...─╮
  │ (no ready tasks) every blocker is OPEN/IN_PROGRESS │   ← gchatui correct
  ...
  ╭─ ⁴ Activity log · last ↑8 ────────────────────...─╮
  │ 14:33:10  worker-1  ·  task.claim  cfp_c_message...│   ← gchatui events correct
  ...

Agents card shows the right NAMES (worker-1 + worker-2 ARE
gchatui's agents) but the OWNED-TASK SUMMARY column is missing
its content — every row reads bare \"—\" for the task summary.
Other cards render gchatui correctly.

This means the bug is NOT the Tab-transition stale-data hypothesis
from the earlier note (it'd repro on every Tab; it doesn't repro
on direct-launch into the same ws). The bug is in the Agents card
itself: it's reading per-agent owned-tasks from
snapshot.inProgress, but the snapshot's inProgress filter or the
filter in cards/agents.tsx is skipping rows where workstream
mismatches OR task ownership is differently keyed.

ROOT CAUSE — REVISED HYPOTHESIS
-------------------------------
src/cli/tui/cards/agents.tsx (line ~58):

    const owned = snapshot.inProgress.filter((t) => t.ownerName === a.name);
    const taskBit = summarizeOwnedTasks(owned).bit;

In gchatui, worker-1 IS busy on cfp_c_messageview_per_row_diff
(per the activity-log row). So snapshot.inProgress should contain
that task with ownerName=\"worker-1\". But the filter returns []
→ taskBit is empty → the row renders just the agent name + idle
marker.

Two candidate causes:
  (a) snapshot.inProgress is filtered by workstream and gchatui's
      inProgress query returns 0 rows when it shouldn't.
  (b) The filter's `t.ownerName === a.name` is comparing names but
      the task's owner field is keyed on `owner_id` not
      `owner_name`, and the snapshot loader populates ownerName
      only for tasks claimed via specific paths.

Inspect: src/state.ts loadWorkstreamSnapshot's `inProgress` query
shape, and src/agents.ts agent rows' name vs owner_id key.

VERIFY (cheap)
--------------
  $ mu task list -w gchatui --status IN_PROGRESS --json | jq '.items[].owner'
  → if shows null/undefined, snapshot.inProgress doesn't have
    ownerName populated. Bug is in src/state.ts or src/tasks.ts.
  → if shows \"worker-1\", bug is in cards/agents.tsx filter
    (probably comparing names case/whitespace differently).

Likely fix
----------
Whichever query path populates the snapshot's per-task owner field,
ensure both:
  - snapshot.inProgress[i].ownerName = the agent NAME (not id), AND
  - the snapshot's agents[i].name uses the same casing/whitespace.

If the SDK has a clean owned-by query that's already used by
\`mu task list --owned-by\`, swap cards/agents.tsx's filter to
that helper (cleaner + tested).

OUT OF SCOPE FOR THIS TASK?
---------------------------
The original task title is about Tab/multi-ws stale render; this
new repro is in single-ws mode and unrelated to Tab. Two options:

  - Treat as the same bug if the underlying cause is shared
    (e.g. Tab also flips through a path that fails to populate
    ownerName for non-current-workstream tasks).
  - Split into a SEPARATE task bug_tui_agents_card_owner_blank if
    the root cause is in cards/agents.tsx vs the multi-ws Tab
    plumbing.

Recommend: the implementer should diagnose first via the cheap
verify steps above, then split into two tasks if the root causes
diverge. The Tab-stale-render fix (snap-to-null on workstream
change) is still valid; the agents-owner-blank issue is separate
and needs its own fix.

UPDATED FINAL ACTION
-------------------
After committing the snap-to-null + the agents-owner fix, run:
    mu task close bug_tui_tab_switch_stale_render -w tui-impl --evidence \"<sha + summary>\"

If the agents-owner fix is split out, file
bug_tui_agents_card_owner_blank as its own task with the cheap
verify recipe + likely-fix note above.
```

### #3 by "π - mu", 2026-05-12T05:27:20.868Z

```
THIRD HYPOTHESIS (2026-05-12) — TOP OF FRAME SCROLLED OFF VIEWPORT
------------------------------------------------------------------
Re-reading the user's screenshot:

  ╭──────────────────────────────────────────────────...─╮   ← Agents BOTTOM border
  │   worker-1  —                                       │
  │   worker-2  —                                       │
  ╰─────────────────────────────────────────────────...─╯
  ╭─ ² Tracks ──────────────────────────────────...─────╮   ← rest renders fine
  │ (no goals) try \`mu task add -w gchatui --title \"...\"\` │
  ...

Notice the TOP border of the Agents card (`╭─ ¹ Agents ...─╮`) is
MISSING entirely from the visible frame. What the user reports as
\"broken Agents card\" is actually \"top row of the Agents card has
scrolled off the top of the pane\". The body rows (worker-1 /
worker-2 with `—`) are real gchatui agents (gchatui has worker-1
+ worker-2 — the agents-owner-blank hypothesis was WRONG).

REVISED ROOT CAUSE
------------------
The frame is one row taller than the visible viewport. ink renders
everything correctly into its virtual buffer, but the alt-screen
scroll region or the cursor-position sync clips the topmost row.
Symptoms:

  - Agents top border missing.
  - Agents body visible.
  - Everything below renders fine (with correct top + bottom
    borders) because subsequent rows aren't clipped.

Likely causes (line up against existing fixes — the user just
hit a regression):

  (a) bug_tui_topalign_v2 (commit 2f90040) added
      `\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l` to ALT_SCREEN_ENTER.
      The `\x1b[H` homes the cursor to row 1, col 1 BEFORE ink
      starts rendering. If ink's first frame is N+1 rows tall
      (where N = stdout.rows), the topmost row is pushed off the
      top.

  (b) bug_tui_render_ghosting_v2 (commit 4f24392) pinned the root
      <Box> to height={rows} + bottom-stick StatusBar. If the
      computed rows is stale (e.g. before SIGWINCH propagates) or
      the frame includes the StatusBar's own row in its budget
      twice, the cards get pushed up by 1.

  (c) feat_tui_multi_workstream (commit d0266a3) added a TabStrip
      ABOVE the cards when N≥2 workstreams. The TabStrip consumes
      one row of vertical budget. If the frame-height calc didn't
      account for it, every card slides up by 1 — and the topmost
      card's top border vanishes off the top of the pane.

CAUSE (c) IS THE LIKELY CULPRIT.
The user's repro is `mu state --tui -w tui-impl,gchatui` (multi-ws),
which is exactly when the TabStrip renders. Single-ws (`mu state
--tui -w gchatui` alone) wouldn't show the TabStrip and would
therefore NOT exhibit this bug. The earlier note assumed the
single-ws repro was broken too — re-verify by actually running
single-ws-only first.

VERIFY (CHEAP)
--------------
1. Single-ws baseline: `mu state --tui -w gchatui`
   Expect: Agents card renders WITH top border + body. If the
   top border is present and the data is correct → cause (c)
   confirmed: TabStrip is consuming a row that the height calc
   didn't subtract.

2. Multi-ws confirm: `mu state --tui -w tui-impl,gchatui`
   Expect: top border missing on the topmost card. Confirms (c).

3. Resize the pane (drag taller). The Agents top border should
   reappear once the pane has +1 row of headroom.

REVISED FIX
-----------
Two layers of the existing fix list still apply:

  - LAYER 1 (snap-to-null on workstream change) is still valid for
    the actual stale-data flicker on Tab transitions. Ship it.
  - LAYER 2 (NEW) — TabStrip's row needs subtracting from the
    cards' vertical budget. In src/cli/tui/app.tsx, the dashboard
    branch wraps everything in <Box height={rows}>. When the
    TabStrip renders (workstreams.length >= 2), the cards need
    to render into rows-1 (or however many rows TabStrip occupies),
    not rows. Easiest: ensure the TabStrip is INSIDE the
    <Box height={rows}> + flexGrow={1} pattern so flexbox
    auto-allocates the cards' share. Verify by adding a test that
    renders the App with workstreams.length=2 and asserts the
    final frame's row count matches stdout.rows exactly (no
    overflow).

The agents-owner-blank theory in the prior note was wrong — the
data IS correct; the chrome is just clipped. Strike that
diagnosis from the notes; the only real bugs are:

  (1) Tab transition lag — snap-to-null fix.
  (2) Multi-ws TabStrip eats a card row — flexbox height fix.

UPDATED FINAL ACTION
-------------------
Two commits:

  Commit 1: tui: discard stale snapshot on Tab/workstream-switch
            (was showing OLD ws's cards under NEW ws's tab for ~tickMs)
  Commit 2: tui: TabStrip row no longer eats topmost card's top
            border — multi-ws frame respects stdout.rows budget

Then close the task with both shas.
```

### #4 by "worker-2", 2026-05-12T06:10:18.393Z

```
CLOSE: a897e8f+3a9c586: snap-to-null on workstream change in useDashboardSnapshot (cards no longer paint stale ws data under new tab); add overflow="hidden" to all 3 height-pinned root Boxes (multi-ws TabStrip's extra row no longer scrolls topmost card's top border off-screen). 4 greens both commits; 1780 tests pass.
```
