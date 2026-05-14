---
id: "design_card_ready"
workstream: "tui"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "scout-2"
created_at: "2026-05-11T10:45:07.161Z"
updated_at: "2026-05-11T11:16:52.808Z"
blocked_by: ["design_card_iface"]
blocks: ["design_complete", "design_popup_tasks"]
---

# Design Ready card: top-N tasks by impact/effort ROI

## Notes (2)

### #1 by "scout-2", 2026-05-11T11:16:48.913Z

```
FILES:
- src/cli/state.ts L595-633   (formatHudTasksTable — current HUD Ready/InProgress renderer; ROI tier
                                colour mapping pc.green/yellow/dim at L626-628; truncate(t.title, titleBudget) at L629)
- src/cli/state.ts L540-593   (formatHudAgentsTable — sibling card render; the per-row column-budget
                                pattern this card should mirror)
- src/cli/format.ts  L84-90   (truncate helper — exact ellipsis rule, used here)
- src/cli/format.ts  L189-206 (static `mu task list` Ready render — full per-row column set we
                                deliberately COMPRESS away from)
- src/cli.ts          L322-323 (byRoiDesc — tie-break we extend)
- design notes consumed: design_locked, design_card_iface (Card<TSlice>),
                          design_poll_loop (per-card render isolation),
                          design_sdk_seam (WorkstreamSnapshot.ready : TaskRow[],
                            roiBucket : (impact, effort) -> 'high' | 'mid' | 'low' | 'infinite')

COMMANDS:
- mu task notes design_locked      -w tui   (locked decisions)
- mu task notes design_card_iface  -w tui   (Card<TSlice> contract; minWidth/minHeight)
- mu task notes design_poll_loop   -w tui   (tick + listTasks(ready) + per-card isolation)
- mu task notes design_sdk_seam    -w tui   (snapshot.ready slice; roiBucket)
- mu state -w tui                            (eyeballed live ROI bucketing, owner column behaviour)

FINDINGS:
1. The HUD's existing Ready render (state.ts L595-633) ALREADY:
   - renders   `ready  <name>  <title>  ROI <n>`
   - hides     status, impact, effort (the static `mu task list` shows them; the HUD compresses)
   - hides     owner (because owner is ALWAYS — for ready tasks: an owned task is IN_PROGRESS,
                not Ready; the HUD only renders owner on the InProgress section via withOwner=true)
   - colours   ROI green ≥100 | yellow ≥50 | dim otherwise
   - title     truncated via truncate(t.title, titleBudget) at L629
   The static `mu task list` (format.ts L189-206) shows the WIDE 7-column form including
   status/impact/effort; that is the popup's job, not the card's.

2. WorkstreamSnapshot.ready (per design_sdk_seam §4) is `TaskRow[]` already pre-sorted by
   listReady().sort(byRoiDesc). No card-side re-sort needed; the card just slices top-N.

3. The popup (design_popup_tasks) is the place to drill in to a row, read notes, and yank
   `mu task claim <id> -w <ws>` / `mu task close ...`. The card itself is read-only glance.

DECISION:

§1. Per-row format (RECOMMENDED — TIGHTER FORM)

      name | title (truncated) | ROI | owner-or-(em-dash)

   Column-by-column:
     - name      cyan, bold, no `ready  ` prefix (the card title + Card.id chip already
                 says "Ready"; the L617 sectionPrefix was a HUD-only crutch when sections
                 were stacked unlabelled in one table). Width = max(name) for the slice.
     - title     truncated via truncate(t.title, titleBudget) (format.ts L85). titleBudget =
                 max(10, width - nameW - roiW - ownerW - padding). Same shape as
                 formatHudTasksTable L621-624.
     - ROI       `<n>` numeric, no `ROI ` prefix (the HUD prefixed because rows were also
                 visually ambiguous with the InProgress section above; the card has its
                 own header). Width = max("ROI", longest formatted value, "∞").
                 Colour via roiBucket (§6).
     - owner     em-dash for unowned (the typical case); bold cyan name when owned.

   REJECTED — wider form
      name (id) | status | title | impact | effort | ROI | owner

   This duplicates `mu task list` output and pushes width past minWidth=40. Glance-ability
   wins: status is implicit ("Ready" filter is in the card label), impact + effort are
   already encoded in ROI, and id == name in mu's vocabulary (TaskRow.name IS the id;
   there is no separate "id" column). The popup (design_popup_tasks) is where you go to
   see status/impact/effort/full title/notes.

   UI principle cite: glanceable cards, drill-down popups (design_locked: "btop-style
   toggleable cards on a glanceable dashboard"; design_card_iface: "the card is the
   summary, the popup is the detail"). Static `mu state` ALREADY follows this rule —
   the L595-633 Ready render is exactly the 4-column form recommended here, minus the
   `ready  ` prefix and the `ROI ` literal. Card just adopts what the HUD already proved.

§2. Sort

   ROI desc (primary) — confirmed; cite byRoiDesc (cli.ts L322-323).

   Tie-break:  effort ASC (cheaper first when ROI ties)
        then:  name ASC  (deterministic)

   Implementation note: snapshot.ready is ALREADY pre-sorted by byRoiDesc per
   design_sdk_seam §4; current byRoiDesc has NO tie-break (returns 0 on equal ROI which
   leaves the listReady DB order intact, which is local_id ASC — accidentally
   deterministic but coincidental). Recommend extending byRoiDesc in src/tasks.ts during
   the SDK seam extraction to add the explicit (effort ASC, name ASC) tie-breaks. The
   ink Ready card MUST NOT re-sort (per design_poll_loop's per-card isolation and the
   "snapshot is the source of truth" rule); if byRoiDesc isn't extended, the card's
   render order silently drifts whenever DB row order changes. Flag for the seam
   implementer; one-line fix.

§3. Top-N

   Default: rowCap = max(3, height - 2)        // -2 = 1 header row + 1 footer/borders
   Floor:    3 (always show at least the top 3 even on a tiny pane; below height < 5
              the dashboard hides the card entirely per Card.minHeight = 4 — see §8).
   Hard cap: NONE within the card itself; bounded by `height` from CardProps. The static
              fallback's literal 10 is right for `mu state` (one-shot snapshot) but
              wrong for a TUI card whose height the dashboard layout already grants.
              Wasting half a tall pane on whitespace would make the dashboard look
              broken; over-filling a short pane is impossible because `height` is
              authoritative.
   Overflow: render `… +N more (Shift+3 to drill in)` as the last visible row when
              snapshot.ready.length > rowCap. The Shift+3 hint is the Card.id=3-binding
              from design_global_keymap (Ready owns Card slot 3 per the
              Agents=1 / Tracks=2 / Ready=3 / Log=4 ordering in design_card_iface).

§4. Empty state

      "No ready tasks — every blocker is OPEN/IN_PROGRESS, or every task is closed.
       Try `mu task list -w <ws>`."

   Rendered as a single dim line, NOT a table. <ws> is the actual workstream name
   (already on CardProps via the snapshot context per design_card_iface). The yank
   verb on this empty-state line: `y` copies the suggested `mu task list -w <ws>`
   to clipboard (per the global yank flow A3' from design_locked) — same key
   binding as a row yank, just with the suggestion as the payload. Helpful,
   discoverable, costs zero extra UI. (Implementation note for the per-card .tsx:
   when `snapshot.ready.length === 0`, set the card's yank-target to the literal
   suggestion string; otherwise yank-target is the focused row's claim command.)

§5. Owner column

   - snapshot.ready filters status=OPEN with no unsatisfied blockers; OPEN tasks are
     by definition unowned (owner_id is cleared on release, and IN_PROGRESS lives in
     snapshot.inProgress not snapshot.ready). So owner=NULL is the EXPECTED case.
   - Render unowned as `pc.dim("—")` — matches the HUD's L632 convention exactly.
   - Render owned as `pc.bold(pc.cyan(name))` — matches the HUD's L632 owned branch.
   - The "claimed but not yet started" case is mostly theoretical (claim flips
     status to IN_PROGRESS atomically per src/tasks/claim.ts); but if it ever
     happens (e.g. a manual `mu sql` poke), the row STILL shows here because the
     filter is OPEN+ready, and the owner cell will correctly display the name —
     no special branch needed.

§6. ROI bucket colour

   Map per design_sdk_seam §9 (roiBucket helper):
     high     → pc.green     (ROI >= 100;  same threshold as state.ts L626)
     mid      → pc.yellow    (ROI >= 50;   same threshold as state.ts L627)
     low      → pc.dim       (ROI <  50;   same threshold as state.ts L628)
     infinite → pc.green     (effort_days = 0; treat as best-possible ROI;
                              the HUD prints "∞" — keep that glyph + green colour)

   Implementation in the card:
     const bucket = roiBucket(t.impact, t.effortDays);
     const colour = bucket === "high" || bucket === "infinite" ? pc.green
                  : bucket === "mid" ? pc.yellow
                  : pc.dim;
     const roiStr = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(0) : "∞";
     <Text>{colour(roiStr)}</Text>   // ink Text + picocolors string is fine; ink
                                     // strips ANSI in a non-tty test env

   Match HUD convention exactly so the static fallback and the ink card look
   identical for the same data — that's the parity guarantee from design_locked
   ("static `mu state` remains the non-TTY fallback"). If a user toggles the
   Ready card off in the TUI and runs static `mu state` instead, the colours
   should not visually shift.

§7. Title truncation

   Use src/cli/format.ts L85 `truncate(s, max)` directly. titleBudget computed as:

     titleBudget = max(10, width - nameW - roiW - ownerW - padding)

   where width comes from CardProps (Card.minWidth = 40 floor; if granted width
   would push titleBudget < 10 the dashboard has already declined to render us per
   Card.minWidth gating in design_card_iface). nameW / roiW / ownerW are computed
   per-render across the visible slice exactly as state.ts L611-614 does today.
   `padding` accounts for column gutters (4 cols → 4*1 = 4 ink-Box gutters; cli-table3's
   `numCols * 3 + 1` is a cli-table3 specific; for ink use `numCols - 1` for one
   space between columns plus 2 for the rounded-border). Round number: padding ≈ 6
   for our 4-column layout; the exact value is the per-card .tsx implementer's call
   inside the ink layout primitives.

§8. minWidth / minHeight (per design_card_iface)

   minWidth  = 40  (4 columns: name 6-12 + title 10+ + ROI 4 + owner 6-12 + 6 padding ≈ 36-40)
   minHeight = 4   (1 header + 1 column-header + 1 row + 1 footer/border;
                    we will degrade to "+N more" if only 1 data row fits)

   These match the design_card_iface defaults for "tight cards"; no special-case
   needed (the Activity-log card is the one that bumps to minWidth=60).

§9. Card vs Popup

   CARD (this task — design_card_ready):
     - 4 columns (name | title | ROI | owner)
     - Top-N rows fitted to height; "+N more" overflow row
     - ROI bucket colour
     - Empty-state line with yank-able `mu task list -w <ws>`
     - Read-only; no row focus, no per-row actions
     - Toggle visibility via `3` (digit binding per design_global_keymap)

   POPUP (sibling — design_popup_tasks):
     - Full task list (no "+N more" cap)
     - All 7 columns of `mu task list` (status/impact/effort/...)
     - j/k row focus, Enter expands to read notes (mu task notes <id>)
     - per-popup verbs from design_card_iface PopupVerbKey pool:
         n = read notes (mu task notes <id>)
         t = tree       (mu task tree <id>)
         b = blockers   (mu task show <id> --blockers)
         c = claim yank (`mu task claim <id> -w <ws> --self`)
         x = close yank (`mu task close <id> -w <ws> --evidence ""`)
         r = release yank (`mu task release <id> -w <ws>`)
     - y = yank focused-row's primary command (default = the claim line)
     - Open via Shift+3 from dashboard (per design_global_keymap)

   The DIVISION: card is the "what's next" glance; popup is the "let me do
   something about it" surface. The card NEVER mutates state; the popup yanks
   commands but does not execute them (per design_locked R1 read-only).

NEXT:
- design_popup_tasks  — implements the drill-in body sketched in §9
- design_global_keymap — verify Ready owns Card slot 3 & Shift+3 (referenced
                          but not authored here)
- src/tasks.ts byRoiDesc extension — add (effort ASC, name ASC) tie-break per §2
                          (one-line change; do during SDK seam extraction)
- src/cli/tui/cards/ready.tsx — implementer copies AgentsCard template from
                          design_card_iface; selects WorkstreamSnapshot.ready;
                          renders per §1; consumes roiBucket per §6.

VERIFIED:
- §1 row format compared 1:1 against state.ts L595-633 (current HUD Ready
  render) — confirmed columns, ROI thresholds, owner em-dash convention,
  truncate call site all match.
- §2 sort confirmed against cli.ts L322-323 byRoiDesc + design_sdk_seam §4
  (snapshot.ready pre-sorted); tie-break extension flagged as a separate
  one-line change so this design holds even if the extension is deferred.
- §6 ROI bucket boundaries verified against state.ts L626-628 (the literal
  threshold constants 100, 50, ∞); design_sdk_seam §9 lifts these into
  roiBucket() so card render and HUD render share one source of truth.
- §7 truncate signature read at format.ts L85; ellipsis behaviour confirmed.
- §8 minWidth=40/minHeight=4 lifted from design_card_iface "tight cards"
  default; no per-card override needed for Ready.
- Live `mu state -w tui` against the design itself reproduced the HUD's
  4-column Ready render with the expected ROI colours and em-dash owners
  (sample row: "design_yank_flow ROI 130.0 —" — green; matches §6 high bucket).
- `mu --help` / `mu task --help` consulted; `--blockers` flag on `mu task show`
  is real (popup verb `b` in §9 cites it).

ODDITIES:
1. snapshot.ready is OPEN-only by listReady's filter; the brief says "top-N
   OPEN tasks with no unsatisfied blockers" which is exactly listReady's
   semantics. We don't need to filter again in the card. If a future
   listReady ever changes semantics (e.g. includes IN_PROGRESS for
   convenience), the card render is still SAFE because the owner column
   degrades gracefully — but the popup might want to add a status column
   in that case. Flag only.

2. ROI = ∞ (effort_days = 0) is rare but real (mu accepts effort_days = 0
   on `mu task add`). The HUD and the card both render the literal "∞"
   glyph. If a terminal can't render U+221E it falls back to "?" — acceptable
   regression; same as the HUD today. If a real user complains, swap to
   "max" string in roiBucket consumer; v0.next.

3. The "Shift+3 to drill in" hint in the overflow row leaks the design_global_keymap
   binding into a card-level UI string. Acceptable: design_card_iface's Card.id
   IS 1..9 by contract, and Shift+<id> for popup IS locked per design_locked.
   If the keymap is ever re-bound (it won't be — locked), the per-card .tsx
   can read the binding from the keymap registry rather than hard-coding
   "Shift+3"; for v0 a literal string is fine.

4. Empty-state yank target (§4) introduces a card-level concept of "yank target
   when no row is focused" that's slightly novel. For non-empty cards the
   yank-target is the focused row; for the Ready card with zero rows it's the
   suggested `mu task list` command. design_card_iface didn't explicitly
   contract this — flag for the iface owner if they want to add an optional
   `Card.defaultYankTarget?: (slice) => string` field. v0 can implement this
   inside the per-card .tsx without iface changes; iface promotion is only
   needed if a 2nd card grows the same need.

5. The card render NEVER consults DB outside the snapshot — per
   design_poll_loop's per-card isolation and design_sdk_seam's
   "snapshot is the contract" rule. There is therefore no listTasksByOwner
   call (unlike formatHudAgentsTable L557). The owner field is already
   denormalised onto TaskRow.ownerName (state.ts L631 uses t.ownerName
   directly). No N+1 risk.

6. The HUD's `ready  ` prefix and `ROI ` literal (state.ts L617, L631) are
   compression artifacts from when InProgress and Ready were stacked in one
   visually undifferentiated table for the HUD's small height budget. The
   card has a real header (Card.label = "Ready") and so doesn't need either
   prefix. Net effect: each row saves ~10 columns vs the HUD's render —
   fits more title in less width. Net win.
```

### #2 by "scout-2", 2026-05-11T11:16:52.808Z

```
CLOSE: Ready CARD design done
```
