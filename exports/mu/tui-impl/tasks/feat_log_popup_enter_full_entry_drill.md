---
id: "feat_log_popup_enter_full_entry_drill"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: null
created_at: "2026-05-12T05:30:24.624Z"
updated_at: "2026-05-12T06:07:25.908Z"
blocked_by: ["bug_tui_log_card_columns_misaligned", "bug_tui_popup_cursor_highlight_color_leak"]
blocks: ["review_tui_code_and_tests"]
---

# FEAT: Log popup — Enter on focused row drills into full untruncated entry (rows clip, drill is the way to read the full payload)

## Notes (2)

### #1 by "π - mu", 2026-05-12T05:31:09.830Z

```
GOAL
----
Wire Enter on the focused Log popup row to drill into a read-only
full-payload view of that single event. Today Enter is intentionally
UNBOUND (per popups/log.tsx:6-10 \"Log entries are already a single
line each — there's no 'detail view' to drill into\"); user feedback
proves that comment wrong:

  user: \"the activity log drill-down list. it says navigation is
         possible, but no highlighted row is rendered. <enter> is
         still valid in this view since long lines are clipped, so
         enter will simply show the full log entry.\"

The `<enter> is still valid` framing is exactly right: long event
payloads (e.g. claim/release lines, multi-field workspace-refresh
events) clip at the column width per
bug_tui_log_card_columns_misaligned. The drill is the affordance
for reading the full payload.

PRECEDENT (do this first if you haven't already)
------------------------------------------------
Two related bugs LIKELY land before this task:

  1. bug_tui_popup_cursor_highlight_color_leak — fixes the
     \"no highlighted row is rendered\" symptom. The cursor IS
     in popups/log.tsx (line 196, `events.indexOf(e) === safeCursor`)
     but renders patchy because the per-cell colour styling leaks
     through the outer `<Text inverse={sel}>`. Once the
     CursorRow primitive lands, the Log popup gets a solid
     cursor line for free.
  2. bug_tui_log_card_columns_misaligned — fixes the column
     overflow that makes the drill USEFUL (today rows wrap; a
     truncate-then-drill flow only makes sense if the truncate
     is reliable).

This feat task is BLOCKED by (1) so the highlighted row works
first. (2) is a related-but-not-blocking dependency.

DESIGN
------
Mirror the exact pattern from feat_track_drill_chains_to_task_drill
and the Tasks/Blocked/Recent/In-progress popup-to-task-detail chain,
adapted for events instead of tasks:

  popups/log.tsx mode union widens from `\"list\" | \"drill\"` to
  the same shape it already has — both are already in the type;
  the existing line 111's `case \"drill\":` branch is the no-op
  the user's complaint targets. Replace the no-op with:

    case \"drill\":
      const e = events[safeCursor];
      if (e !== undefined) onModeChange(\"drill\");
      return;

Render branch (when mode === \"drill\" and a focused event exists):

    if (mode === \"drill\" && focused !== undefined) {
      return (
        <Shell title={`Activity log · #${focused.seq} (${focused.createdAt.slice(11,19)})`}>
          <DrillScrollView
            title=\"event payload\"
            body={focused.payload}    // full untruncated payload
            viewport={popupViewport(rows)}
            scrollTop={detailScrollTop}
          />
        </Shell>
      );
    }

DrillScrollView already exists (popups/drill.tsx). The body for
events is plain text — single-line per event most of the time,
multi-line for the workspace-refresh / task-add payloads with
embedded newlines. j/k scrolls the body lines, q/Esc backs out
to the list. Same primitives every other popup-drill uses.

KEY MAP (drill mode)
--------------------
  j/k Ctrl-D/U PgUp/PgDn  scroll
  g/G                     jump top/bottom
  y                       yank `mu log -n <seq> -w <ws>` (the
                          single-event-by-seq command — verify
                          mu's CLI supports `-n` filter; if not,
                          yank `mu log` and let the user filter)
  Esc / q                 back to list

NEW LOCAL STATE
---------------
    const [detailScrollTop, setDetailScrollTop] = useState(0);

    // Reset on focused-event change.
    useEffect(() => { setDetailScrollTop(0); }, [safeCursor]);

ALSO REMOVE THE SILENT NO-OP COMMENT
------------------------------------
popups/log.tsx:6-10 currently reads:

    // Enter is intentionally UNBOUND on this popup. Log entries are
    // already a single line each — there's no \"detail view\" to drill
    // into. The dispatchPopupKey returns {kind:\"drill\"}; we silently
    // discard it.

Replace with:

    // Enter on a focused row drills into a read-only inline view
    // of the event's full untruncated payload. Long payloads
    // (workspace-refresh events, multi-field task.claim notes,
    // multi-line task notes summaries) clip in the list view per
    // bug_tui_log_card_columns_misaligned; the drill is the
    // single-source affordance for reading the full text. j/k
    // scroll the drilled payload; q/Esc back to list.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: Log popup Enter drills into full event payload (was a
         silent no-op; long payloads needed the drill affordance
         for read-out)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish or v0.4.1): bullet under TUI
  features.
- docs/USAGE_GUIDE.md TUI section: extend the popup-keymap line
  to mention Log Enter→drill.
- skills/mu/SKILL.md TUI keymap: same.

TESTS
-----
- test/tui-popup-log.test.ts: extend with the new mode='drill'
  branch; assert source contains the case branch + the
  DrillScrollView render with body=focused.payload.

OUT OF SCOPE
------------
- Don't add filtering on event class / agent / task in this task
  (the '/' filter primitive already covers list-mode filtering).
- Don't extend log popup to show RELATED events (e.g. all events
  for the same task) — separate task if asked.
- Don't change the yank-target matrix on the LIST mode; only add
  the drill-mode yank.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_log_popup_enter_full_entry_drill -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-12T06:07:25.908Z

```
CLOSE: 020dedf: Log popup Enter now drills into full untruncated event payload via shared DrillScrollView (j/k scroll, y yanks 'mu log --since N-1 -n 1 -w ws', Esc/q back). Header comment, test, CHANGELOG, USAGE_GUIDE, SKILL.md updated. Four greens.
```
