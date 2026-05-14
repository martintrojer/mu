---
id: "docs_usage_guide"
workstream: "tui"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "designer-2"
created_at: "2026-05-11T10:45:24.125Z"
updated_at: "2026-05-11T11:02:29.265Z"
blocked_by: ["design_global_keymap"]
blocks: ["design_complete"]
---

# Draft USAGE_GUIDE.md update: new TUI section + remove --hud refs

## Notes (2)

### #1 by "designer-2", 2026-05-11T11:02:27.050Z

````
FILES (proposed USAGE_GUIDE.md edits — explicit line ranges):

A. docs/USAGE_GUIDE.md L14-L21 (header status blurb)
   Current text mentions "default / `--hud` / `--mission` render modes".
   Replace fragment "default / `--hud` / `--mission` render modes" with
   "interactive TUI in a TTY, static card otherwise".
   Same paragraph; keep surrounding sentence intact.

B. docs/USAGE_GUIDE.md L403-L470 (whole "### `mu state` render modes" subsection)
   Currently: ~67 lines documenting default / --hud / --mission, the
   bare-`mu` alias, multi-workstream behaviour, the JSON-shapes-per-mode
   matrix, and the "Migrating from `mu hud`" callout.
   Action: REPLACE WHOLESALE with the new "### `mu state` and the
   interactive TUI" subsection drafted below (DRAFT-NEW-SECTION).
   The new subsection covers: mental model (TTY vs non-TTY),
   the four v0 cards, the keymap summary table, the yank model,
   and the "what changed from --hud" callout.

C. docs/USAGE_GUIDE.md L1663 (gaps table row, "Pi extension (typed
   tools, HUD, wakeups)")
   Current cell: "`mu state --hud` covers the HUD use-case (run via
   `watch` / `tmux display-popup` / `status-right`). Other extension
   tools deferred."
   Replace with: "Bare `mu` / `mu state` in a TTY is the interactive
   HUD; `mu state --json` (or non-TTY) is the static-card surface for
   `watch` / `tmux display-popup` / `status-right`. Other extension
   tools deferred."
   Status column unchanged ("partially shipped").

D. (No other --hud references exist; grep -n "hud\|--hud\|state --hud"
   returns lines 16, 403, 411, 422, 424-426, 432, 440, 446, 456,
   462-464, 1663 — all are inside the ranges above. Edit B subsumes
   403/411/422/424-426/432/440/446/456/462-464; edit A handles 16;
   edit C handles 1663.)

COMMANDS:
- mu task notes design_locked         -w tui   # locked decisions
- mu task notes design_global_keymap  -w tui   # designer-1 keymap (source of truth)
- grep -n "hud\|--hud\|state --hud" docs/USAGE_GUIDE.md
- read docs/USAGE_GUIDE.md L1-60, L395-470, L1655-1685

FINDINGS:
- Every `--hud` mention in USAGE_GUIDE.md is within the three edit
  ranges above (A, B, C). No stragglers.
- The existing `### mu state render modes` subsection is the natural
  host for the new TUI section: same heading slot, same neighbours.
  Replacing it in place keeps the table-of-contents anchor stable
  ("§5 — see the graph (mission control)" already links to it).
- Designer-1's SUMMARY TABLE in `mu task notes design_global_keymap
  -w tui` is exactly the right scope for the doc — two columns
  (GLOBAL / IN-POPUP), ~14 rows each, fits one screen. Borrowed
  verbatim below.
- Yank model: drafted in three lines per the brief, deliberately
  omitting the per-backend matrix (pbcopy / xclip / wl-copy details).

DECISION:

================================================================
DRAFT-NEW-SECTION (drop-in replacement for L403-L470)
================================================================

### `mu state` and the interactive TUI

`mu state` is one verb with two surfaces, picked automatically by
the output target.

```bash
mu                          # interactive TUI (TTY) — bare alias for `mu state`
mu state                    # interactive TUI (TTY); static card if stdout is not a TTY
mu state --json             # always static (machine-readable JSON envelope)
mu state -w a -w b          # multi-workstream; --all for every workstream
```

- **Interactive (TTY)** — bare `mu` or `mu state` opens a
  read-only btop-style dashboard. The TUI never executes mu verbs;
  it yanks them. Quit with `q` or `Ctrl-C`.
- **Static (non-TTY or `--json`)** — same data, one card on stdout.
  This is the surface to compose with `watch -n 5 mu state -w X`,
  `tmux display-popup -E 'mu state -w X'`, or
  `#(mu state -w X --json) | jq ...` for tmux status-bar
  interpolation.

The interactive TUI ships with four toggleable cards (v0):

- **Agents** — registry rows + detected status, one per pane.
- **Tracks** — independent subtrees (parallel-track union-find with
  diamond merge); use this to size your crew.
- **Ready** — actionable-now tasks, ROI-sorted (impact / effort).
- **Activity log** — recent `mu_log` events (state changes, claims,
  notes), most-recent-first.

Cards 5–9 are reserved for future additions (Workspaces, Snapshots,
Archives, ...) so the muscle memory of 1–4 is stable.

#### Keymap (one-screen reference)

The full binding is the source-of-truth note
`mu task notes design_global_keymap -w tui` (designer-1); the
summary table below mirrors it.

```
GLOBAL (dashboard)                 IN-POPUP (any popup)
------------------                 --------------------
1-9    toggle card                 j/k    move selection
!-(    open card popup             g/G    first/last
       (Shift+1..Shift+9)          /      filter
+/=    faster tick                 n/N    next/prev match
-      slower tick                 Esc    close popup
0      reset tick (1s)             q      close popup (alias)
r/F5   refresh now                 y      yank focused command
?/F1   help overlay                ?      help overlay
q/Q    quit                        +/-/=/0 tick adjust (live)
Ctrl-C quit                        r/F5   refresh now
c      clear footer                Ctrl-C quit
w      workstream picker (v0.next)
```

Tick rate floor 100ms, ceiling 10s, default 1s. Single-popup
invariant: opening a popup hides the dashboard; closing restores
the prior toggle + tick state. Press `?` in either mode for the
in-app help overlay.

#### Yank model

The TUI is read-only by design — it never runs mu verbs for you.

- `y` (inside any popup) copies the canonical `mu …` command for
  the focused row to the system clipboard.
- Clipboard backend (`pbcopy` / `xclip` / `wl-copy`) is
  auto-detected; first one available wins.
- If no backend works, the command still appears in the dashboard
  footer (`last: mu agent close worker-1 -w tui`) so you can
  mouse-select and paste it manually.

#### What changed from `mu state --hud`

> The `--hud` flag was removed. `mu state --hud` (and the
> `--mission` flag, and the bare-`mu` alias for `--mission`) are
> all replaced by the single-verb model above: interactive in a
> TTY, static otherwise. `tmux display-popup -E 'mu state --hud
> -w X'` becomes `tmux display-popup -E 'mu state -w X'` (a popup
> is non-interactive shell from mu's POV — it gets the static
> card). `watch -n 5 mu state --hud -w X` becomes
> `watch -n 5 mu state -w X` for the same reason. See
> [CHANGELOG.md](../CHANGELOG.md).

================================================================
END DRAFT-NEW-SECTION
================================================================

NEXT:
- impl_usage_guide_edit (sibling/follow-up): apply edits A, B, C
  literally; verify the `## Table of contents` still resolves
  (anchor stays "#5-see-the-graph-mission-control"); rebuild docs.
- design_changelog_amend: CHANGELOG entry must explicitly say
  `mu state --hud` and `mu state --mission` flags are removed and
  the bare-`mu` alias is rebound from `--mission` to "interactive
  TUI". The Migrating-from-`mu hud` callout is gone; the new
  callout above takes its place.
- docs_vision_amend / docs_roadmap_amend (per design_locked):
  retire "No render layer beyond cli-table3 + picocolors" pillar
  in favour of "+ ink for TUI"; carve the "every invocation is
  short-lived" exception for interactive `mu` / `mu state`.

VERIFIED:
- grep over docs/USAGE_GUIDE.md confirms 13 lines mention
  `hud`/`--hud`/`state --hud` (16, 403, 411, 422, 424, 425, 426,
  432, 440, 446, 456, 462, 463, 464, 1663). All are inside edit
  ranges A (16), B (403-470), C (1663).
- Keymap summary table matches `mu task notes design_global_keymap
  -w tui` SUMMARY TABLE section verbatim (line-for-line equal).
- Card list (Agents / Tracks / Ready / Activity log) matches
  design_locked locked decision "Card v0 set" verbatim.
- Existing USAGE_GUIDE voice spot-checked: terse, copy-pasteable
  fenced blocks, "What changed" callouts use blockquote style
  (matches the original "Migrating from `mu hud`" block).

ODDITIES:
- The bare-`mu` semantic is changing: was `mu state --mission`
  (stripped 5-col card), now interactive TUI. Anyone with shell
  history full of `mu | grep ...` or `mu | head` will get a TUI
  that prints nothing useful when stdout is a pipe — but the
  TTY-detect path falls through to the static card on a pipe, so
  the pipe case still works. Worth a CHANGELOG callout (see NEXT).
- Multi-workstream behaviour for the TUI is NOT yet specified by
  the locked decisions. The draft above mentions `-w a -w b` /
  `--all` only in the static-card example to avoid over-promising.
  If the TUI needs to handle multi-ws on day 1, that's a sibling
  design task (design_tui_multi_workstream); flag for designer-1.
- The `### mu state` heading slot is preserved (anchor unchanged),
  but the sub-anchor `#mu-state-render-modes-default---hud---mission`
  in the table of contents (if any internal link exists) would
  break. grep for that anchor turns up nothing in this repo, so
  safe — but the impl agent should re-grep for "render-modes"
  before applying.
````

### #2 by "designer-2", 2026-05-11T11:02:29.265Z

```
CLOSE: TUI section drafted; --hud refs catalogued in note
```
