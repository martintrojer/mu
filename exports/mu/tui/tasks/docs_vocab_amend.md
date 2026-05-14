---
id: "docs_vocab_amend"
workstream: "tui"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "designer-2"
created_at: "2026-05-11T10:45:23.874Z"
updated_at: "2026-05-11T11:25:30.352Z"
blocked_by: ["design_card_iface", "design_yank_flow"]
blocks: ["design_complete"]
---

# Draft VOCABULARY.md additions: card, popup, tick, yank, footer-toast

## Notes (2)

### #1 by "designer-2", 2026-05-11T11:25:28.228Z

```
FILES:
- docs/VOCABULARY.md (canonical-terms table, rows 21–66 today; insertion target after row 67 `CLI`, before row 68 `extension`)
- skills/mu/SKILL.md L13 ("textual card on stdout"), L141 ("read the card") — confirms prose use of "card" pre-TUI
- docs/USAGE_GUIDE.md L410-448 ("full card", "glance card", "Truncated tables get a `… +N more` footer", "not glanceable") — confirms prose use of "card", "footer", "glanceable" pre-TUI
- docs/VISION.md L25,L59,L183,L376,L398,L419 — "state card", "state cards" used in prose
- src/cli/state.ts L1, L10 — "canonical state card" comment in code
- design_locked / design_card_iface / design_yank_flow / design_global_keymap / design_help_overlay (notes on tasks of the same name in -w tui)

COMMANDS:
- `mu task notes design_locked -w tui`            (read locked decisions)
- `mu task notes design_card_iface -w tui`        (read Card / Popup contract)
- `mu task notes design_yank_flow -w tui`         (read yank/toast/footer)
- `mu task notes design_global_keymap -w tui`     (read keymap incl. tick / popup / help)
- `mu task notes design_help_overlay -w tui`      (read help overlay design)
- `grep -nE "card|dashboard|popup|toast|footer|glanceable|drill-down|TUI|tick|yank|help overlay" docs/ src/ -r`
  (homonym hunt across the repo; results summarised in FINDINGS)

FINDINGS:

1. HOMONYM AUDIT (existing meanings of the requested terms in mu today)

   | Term         | Prior use in repo                                                              | Collides? | Resolution chosen                                                                 |
   | ------------ | ------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------- |
   | TUI          | Adjective only ("the agent's TUI", "TUI input"); not a defined noun.           | NO        | Define cleanly as the new noun.                                                   |
   | dashboard    | Not used.                                                                      | NO        | Coin freely.                                                                      |
   | card         | "state card" / "canonical state card" / "mission card" — the *whole-output*    | YES (soft)| Keep bare `card` for the new TUI-tile sense (it's the dominant new use). Entry   |
   |              | text card from `mu state`. Loose prose, never tabled.                          |           | explicitly notes the older "state card" usage is the whole-output card and is    |
   |              |                                                                                |           | unrelated. No need to rename existing prose.                                      |
   | popup        | `tmux display-popup` (literal tmux feature) in USAGE_GUIDE examples.           | YES (soft)| Disambiguate in the entry: "TUI popup" sense; the tmux feature is referred to    |
   |              |                                                                                |           | by its full name `tmux display-popup` in mu docs.                                 |
   | tick         | Not used.                                                                      | NO        | Coin freely.                                                                      |
   | yank         | Not used.                                                                      | NO        | Coin freely.                                                                      |
   | footer       | "Truncated tables get a `… +N more (<verb>)` footer" (USAGE_GUIDE).            | YES (soft)| Accept the homonym; both senses are local to their renderer. New entry says      |
   |              |                                                                                |           | "the dashboard's bottom row".                                                     |
   | toast        | Not used.                                                                      | NO        | Coin freely.                                                                      |
   | act-intent   | Not used.                                                                      | NO        | Coin freely; this is the load-bearing R1 read-only term.                         |
   | help overlay | Not used.                                                                      | NO        | Coin freely.                                                                      |
   | glanceable   | Used as informal adjective in USAGE_GUIDE ("not glanceable") and as a design   | NO        | Promote the existing informal usage to a tabled entry.                            |
   |              | property in the locked notes.                                                  |           |                                                                                   |
   | drill-down   | Not used.                                                                      | NO        | Coin freely.                                                                      |

   No HARD collisions. Three soft collisions (`card`, `popup`, `footer`); each is resolved
   by disambiguating language inside the new entry rather than renaming existing prose
   (the existing prose uses are sparse and always carry their own scoping word —
   "state card", "tmux display-popup", "table footer").

2. ALPHABETICAL POSITION
   The canonical-terms table is THEMATIC, not strict-alphabetical (e.g. workstream → tmux
   session → window → pane appears in topology order). The bottom of the table is the
   "surfaces + infrastructure" cluster: doctor → CLI → extension → skill → DB → substrate →
   operation → reconcile → adopt → pi-subagents.
   The TUI vocabulary is a NEW SURFACE, so the right insertion point is INSIDE that
   surfaces cluster, immediately AFTER the `CLI` row and BEFORE the `extension` row.
   That keeps "the two ways the user talks to mu" (CLI then TUI) adjacent. Within the
   TUI block itself the entries follow a structural order (TUI → dashboard → card →
   popup → glanceable → drill-down → tick → yank → act-intent → toast → footer → help
   overlay) — same order any reader would meet them while learning the surface, not
   strict alphabetical, matching the rest of the table.

3. RESERVED/AVOIDED-TERMS TABLE
   The avoided-terms table at the bottom of VOCABULARY.md ("subagent", "session",
   "project", …) does NOT need new rows for the TUI block: none of the proposed terms
   trigger any of the existing avoidances (no "panel", "widget", "tab", "tile",
   "screen", "modal", "dialog", "tray", "menu" — and we don't NEED to forbid those
   yet; the per-popup design tasks haven't sprouted any).
   ODDITY-flag: if v0 implementation sprouts "panel" or "widget" as a synonym for
   `card`, ADD a row. Not needed today.

4. EXACT DIFF (insert these 11 rows in the canonical-terms table; the
   anchor lines are the unchanged `CLI` row above and `extension` row
   below)

   --- a/docs/VOCABULARY.md
   +++ b/docs/VOCABULARY.md
   @@ canonical-terms table, between `CLI` and `extension` @@
    | **CLI**               | The `mu` command-line binary                                             | "tool" (overloaded), "binary" (only when relevant) |
   +| **TUI**               | The interactive `mu` / `mu state` view: an `ink`-rendered, full-screen, read-only dashboard with toggleable cards and per-card drill-down popups. Replaces `mu state --hud` on a TTY; the static `mu state` text card is the non-TTY/CI fallback. | "interactive mode", "watch mode"                    |
   +| **dashboard**         | The TUI's top-level screen: up to nine **cards** laid out at once, plus a **footer**. The state every keypress returns to. | "home screen", "main view"                          |
   +| **card**              | A glanceable summary tile on the **dashboard**, addressed by digit `1`–`9` (toggle visibility). Distinct from the colloquial "state card" used elsewhere for the whole-output text card from `mu state`. | "panel", "widget", "tile"                           |
   +| **popup**             | A fullscreen drill-down opened with `Shift+1`..`Shift+9` for the matching **card**'s subject. Single-popup invariant: at most one popup is open at a time; `Esc`/`q` closes it and restores the prior dashboard state byte-identical. The TUI's `popup` is unrelated to the literal tmux feature `tmux display-popup`. | "modal", "drawer", "screen"                          |
   +| **glanceable**         | Design property of a **card**: readable at a glance, no cursor, no row interaction. Anything requiring selection or scrolling belongs in a **popup**, not a card. | "summary view"                                       |
   +| **drill-down**         | Design property of a **popup**: full-screen, focused, scrollable, filterable, row-selectable. The mode you enter when a card's information density exceeds glanceable. | "detail view", "deep dive"                           |
   +| **tick**              | The TUI's periodic data refresh. Default 1s; `+`/`=` halves it, `-` doubles it (floor 100ms, ceiling 10s); `0` resets to default; `r`/`F5` forces an immediate tick. The footer always shows the current rate. | "poll", "refresh interval"                          |
   +| **yank**              | Inside a **popup**: copy the canonical `mu` command for the focused row to the clipboard. Pure copy; never executes. The clipboard backend is auto-detected (native CLI → OSC-52 → none); the **footer** persists the last yanked command. | "copy", "grab"                                       |
   +| **act-intent**         | The conceptual `mu` command a `y` (**yank**) keypress would put on the clipboard for the focused row. The TUI's R1 read-only invariant: act-intents are CONSTRUCTED and YANKED, never EXECUTED, by the TUI. | "action", "command intent"                          |
   +| **toast**             | A transient one-line message inside a **popup** (e.g. yank confirmation, "tick floor 100ms", "press Esc to return to dashboard"). Self-dismissing on the next keypress or after 2s. | "notification", "flash"                             |
   +| **footer**            | The persistent bottom row on the **dashboard** showing the current **tick** rate and the most recent **yank** (`last: <command>  [copied]`). Cleared by `c`. Distinct from the truncated-table `… +N more (<verb>)` footer that decorates static-render tables. | "status bar", "footer line"                          |
   +| **help overlay**      | The `?` / `F1` modal listing the global dashboard keymap, the in-popup keymap, and (when a popup is open) that popup's per-popup verbs. Orthogonal to the popup mode: opens over either dashboard or popup, dismisses with `?`/`F1`/`Esc`/`q`-within-help, and restores the underlying mode untouched. NOT a popup (does not occupy the single-popup slot). | "help screen", "cheat sheet"                         |
    | **extension**         | The pi extension shipped in the same package                             | "plugin"                                           |

5. NON-DIFF NOTES (for the implementer / reviewer of this amendment)
   - The new entries' "Don't use" column is populated for terms that have credible
     alternatives in adjacent ecosystems (tile/panel/widget/modal/drawer/notification).
     Where no credible alternative exists I left the column with a single workmanlike
     synonym; biome / lint won't enforce this column either way.
   - Every cross-reference inside the new entries (`card`, `popup`, `footer`, `dashboard`,
     `tick`, `yank`) uses **bold** to match the rest of the table's cross-reference
     convention.
   - All 11 entries pass the existing voice tests: terse, definitive, no examples
     (the parenthetical `(e.g. ...)` in `toast` is a clarifying enumeration of
     the message KINDS, not a usage example — same shape the existing `pi-subagents`
     and `archive label` rows use).
   - The TL;DR-table heading at the top (line 12) reads "TL;DR — canonical terms"
     and lists ONE row per concept; no edit needed there since the table itself
     IS the canonical-terms table. No separate per-section heading is added — the
     TUI block lives inline in the existing single table.

DECISION:
Adopt the 11-row block above, inserted between the `CLI` and `extension` rows of
docs/VOCABULARY.md's canonical-terms table. Resolve the three soft homonyms
(`card`, `popup`, `footer`) inline in the new entries' definitions rather than
renaming existing prose. No avoided-terms additions for v0; revisit if the
implementation tasks introduce "panel" / "widget" / "modal" / "tile" / "screen"
synonyms.

NEXT:
- impl_vocab_amend (or fold into the TUI implementation umbrella's docs task):
  apply the diff above verbatim. Diff is 12 changed lines (1 anchor + 11 inserts);
  no other prose in VOCABULARY.md needs to move.
- After the amendment lands, audit USAGE_GUIDE.md / VISION.md for any new
  `mu state --hud` references that should now point to the TUI section (separate
  task: docs_usage_guide_tui_section).
- v0.next: if "workstream picker" (`w` key) ships, ADD a `workstream picker` row
  to the TUI block in the same alphabetical position the implementation uses.
  Not in scope today.

VERIFIED:
- Cross-checked against design_locked: the locked terms TUI / dashboard / card
  (toggleable, btop-style) / popup (Shift+digit, single-popup invariant, restore-
  prior-state) / yank-as-A3' / footer / toast / tick (1s default, +/- floor/ceiling)
  all appear verbatim in the proposed entries. Read-only/act-intent (R1) is
  captured as a load-bearing definition, not buried in prose.
- Cross-checked against design_card_iface: `card` definition matches §1's "id 1..9"
  + minWidth/minHeight + glanceable contract; `popup` definition matches §2's
  Popup contract + single-popup invariant from design_popup_lifecycle; `yank`
  definition matches PopupProps.yank surface (popups call it; never see clipboard
  internals); `toast` matches the §3 popup-local 2s + next-keypress dismissal;
  `footer` matches the always-visible 1-row Box at dashboard bottom + clear-on-`c`.
- Cross-checked against design_yank_flow: backend ladder (native CLI → OSC-52 →
  none) appears in the `yank` entry; "[copied]" / "[no clipboard]" footer suffix
  is implicit in the entry's `last: <command>  [copied]` example. The R1 "pure
  copy; never executes" invariant is captured both in `yank` and (more emphatically)
  in `act-intent`.
- Cross-checked against design_global_keymap: `tick` entry matches the +/-/=/0
  semantics + 100ms..10s bounds + r/F5 force-poll exactly as the SUMMARY TABLE
  encodes them; `footer` entry references the always-shown tick rate.
- Cross-checked against design_help_overlay: `help overlay` entry matches §1's
  "orthogonal boolean mode, NOT a popup, layered, dismissed with ?/F1/Esc/q-WITHIN-
  help, underlying mode preserved" decision; the per-popup-section behaviour is
  captured ("when a popup is open … that popup's per-popup verbs").
- Cross-checked against the existing canonical-terms table voice: every new row
  is one or two sentences, matches the bold-term/definition/avoid-list shape,
  no examples-by-illustration, follows existing cross-reference style. The
  `TUI` row is the only one that mentions a peer concept (`mu state --hud`) by
  name — same pattern as the existing `recreate` row mentioning `refresh`.
- Cross-checked against AGENTS.md "When you change behaviour, update VOCABULARY
  first" — this DRAFT note IS that update; the implementer who lands the TUI
  module amends VOCABULARY.md in the same commit per the project's own rule.
- Cross-checked against ROADMAP anti-feature pledges: no new dependency, no
  new abstraction with zero implementors, no config file is implied by any of
  the entries. The `tick` rate is keyboard-driven, not env-var-driven.
- No edit needed to the "Reserved / avoided terms" table (audited; no overlap).
- No edit needed to "Mode of address" (no new surface needs a row; TUI's "you"
  is the same human user as the CLI).
- No edit needed to "Type of session" (TUI doesn't introduce a new session sense).

ODDITIES:
- The `card` homonym is the only entry with non-trivial prior-art friction.
  Existing prose in 4 docs (VISION, USAGE_GUIDE, ARCHITECTURE, src/cli/state.ts
  comment) uses "state card" / "canonical state card" / "mission card" /
  "glance card" to mean the whole-output text from `mu state`. The new `card`
  entry handles this with one parenthetical disambiguator; we deliberately do
  NOT mass-rename "state card" → "state output" across those docs (would touch
  ~10 sites and provide no clarity gain — the modifier "state" already scopes
  it to a different surface). If a future reader is confused, the per-entry
  cross-reference is enough.
- `popup` collides with `tmux display-popup` (used in 4 USAGE_GUIDE recipes for
  embedding `mu state` in a tmux popup). The mu-side `popup` is unambiguously
  the TUI sense in TUI prose; tmux's popup is always referred to by its
  full command name in mu docs. No rename needed there either.
- The TL;DR table's "Don't use" column entries for the new rows are best-effort.
  The table doesn't enforce these; lint checks neither column. They exist as
  hints to a future reviewer/agent who is tempted to write "modal" or
  "notification". If a real reviewer hits one and disagrees, the per-entry
  promotion criterion in ROADMAP applies.
- The TUI block sits between `CLI` and `extension` in the surfaces cluster.
  An alternative position (after `pi-subagents` as a fresh terminal block) was
  rejected: pi-subagents is a "compare against" entry, and putting TUI after
  it would visually demote the TUI to "footnote" status. The chosen position
  reads as "CLI then TUI then the rest of the surface infrastructure", which
  matches how a learner encounters mu.
- `act-intent` is the most conceptually load-bearing new term and the one most
  at risk of being called "action" or "intent" by sloppy code. We deliberately
  hyphenated it (vs. `actIntent` / "act intent") to make it a single
  searchable token. Implementers should grep `act-intent` to find every
  reference; this matches the convention used by `task DAG` (search-friendly
  multi-word noun phrase).
- Glanceable / drill-down are framed as DESIGN PROPERTIES, not surface nouns.
  This deliberately mirrors the existing entry pattern for `persistent` /
  `one-shot` (also framed as agent properties, not nouns). Keeps the
  vocabulary's part-of-speech consistency.
```

### #2 by "designer-2", 2026-05-11T11:25:30.352Z

```
CLOSE: VOCABULARY.md additions drafted in note
```
