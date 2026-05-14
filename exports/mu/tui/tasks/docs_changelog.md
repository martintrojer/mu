---
id: "docs_changelog"
workstream: "tui"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: "scout-1"
created_at: "2026-05-11T10:45:23.988Z"
updated_at: "2026-05-11T11:04:28.634Z"
blocked_by: ["docs_roadmap_amend", "docs_vision_amend"]
blocks: ["design_complete"]
---

# Draft CHANGELOG.md entry under upcoming version

## Notes (2)

### #1 by "scout-1", 2026-05-11T11:04:25.403Z

```
FILES:
- /Users/mtrojer/hacking/mu/CHANGELOG.md (read in full; latest entry is [0.3.2] 2026-05-11)
- mu task notes design_locked          -w tui  (locked decisions; 4 v0 cards; --hud replaced)
- mu task notes investigate_render_lib -w tui  (ink decision + cost ledger)
- mu task notes docs_roadmap_amend     -w tui  (ROADMAP pledge replacement text)
- mu task notes docs_vision_amend      -w tui  (VISION Constraint #6 → adds #7)
- mu task notes design_global_keymap   -w tui  (keymap; user-facing surface)
- mu task notes audit_state_ts         -w tui  (--hud-only surface to delete)

COMMANDS:
- mu task list -w tui --json | jq … (resolved sibling-task status; design_complete still OPEN)
- grep -n "0\.\(3\|4\)\.[0-9]" CHANGELOG.md (latest header confirmed [0.3.2])
- Re-read of "Breaking" / "Removed" / "Added" / "Changed" voice in 0.3.0/0.3.1/0.3.2 entries

FINDINGS:

1. **Version header — 0.4.0, not 0.3.3.** Three reasons, all from the
   CHANGELOG's own pre-1.0 SemVer rule ("pre-1.0 minor versions may
   include breaking changes called out under 'Breaking' in each entry"):
   (a) `--hud` removal is a USER-FACING REMOVAL of a flag we shipped in
       0.3.0 (`merge_state_into_hud_render_mode`). 0.3.x has been the
       "render-mode flag on `mu state`" line; removing it ends that line.
   (b) Bare `mu` semantics shift in a TTY (was static mission card,
       becomes interactive TUI). Scripts that piped `mu` (no `--json`)
       and parsed text would break; the `isTTY` gate protects them, but
       interactive humans see a different default.
   (c) Two pillar amendments (VISION Constraint #7, ROADMAP render-layer
       pledge). Pillars are load-bearing per AGENTS.md; amending two of
       them in one wave is exactly the size of change the project's
       "minor bump for breaking" rule was written for.
   Patch (0.3.3) would mis-signal scope. 0.4.0 is the right call.

2. **Section voice.** CHANGELOG.md uses Added / Changed / Removed /
   Breaking / Fixed (per 0.3.0–0.3.2). "Pillar amendments" is NOT a
   section header anywhere in the existing voice, and the brief itself
   says "Don't invent new section names." Pillar amendments land as
   ONE-LINE entries inside Changed, prefixed `Pillar amendment —` so a
   skim still finds them. The `--hud` removal sits under Removed; the
   bare-mu TTY shift sits under Changed; the new dep family is one
   bullet under Added (the TUI verb itself is the headline bullet).

3. **No "Breaking" subsection needed.** The `--hud` removal is the
   only operator-visible breaking surface; "Removed" already carries
   that signal in this CHANGELOG's voice (see 0.3.2's pre-v0.3 export
   detection removal — same shape). Pillar amendments are documented
   commitments, not API; they belong in Changed.

DECISION — DRAFT CHANGELOG ENTRY (drop-in for the top of CHANGELOG.md
above the [0.3.2] header):

----- BEGIN DRAFT -----

## [0.4.0] — 2026-05-1X

Feature theme: the interactive TUI. `mu` (and `mu state` in a TTY)
now opens a btop-style toggleable-card dashboard backed by `ink`,
replacing the `mu state --hud` render mode added in 0.3.0. The
TUI is read-only — act-intents yank the canonical `mu <verb>`
command instead of executing it, so every state mutation still
flows through a fresh short-lived CLI invocation. Static `mu state`
(non-TTY / `--json`) is unchanged.

### Added

- **`mu` / `mu state` interactive TUI mode** (TTY-gated; `--json`
  and non-TTY callers fall through to the existing static card).
  Four v0 cards on a glanceable dashboard: **Agents**, **Tracks**,
  **Ready**, **Activity log**. Cards toggle on the dashboard via
  `1`–`9`; `Shift`+`1`–`9` opens that card as a single fullscreen
  popup (single-popup invariant; closing restores the prior
  dashboard state and tick rate). In-popup convention is consistent
  across cards (`j`/`k` move, `g`/`G` jump, `/` filter, `n`/`N`
  next/prev match, `Enter` open detail, `Esc`/`q` close, `y` yank
  focused command, `?` help overlay). Dashboard-global keys:
  `+`/`-`/`=`/`0` adjust the 1s poll tick (floor 100 ms, ceil 10 s),
  `r`/`F5` refresh now, `?`/`F1` help overlay, `q`/`Q`/`Ctrl-C`
  quit. Yank flow writes the act-intent to the clipboard when one
  is available, shows a transient toast in the popup, and pins the
  last yanked command to a persistent footer line on the dashboard
  (e.g. `last: mu agent close worker-1 -w tui [copied]`). Toggle
  state is intentionally NOT persisted across runs (sidesteps the
  no-config-file pledge). Full keymap reference lives in
  [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md) (the "TUI keymap"
  section added in this release).

- **New peer deps for the TUI subtree only**: `ink`, `react`,
  `react-reconciler`, `yoga-layout-prebuilt`. Confined to
  `src/tui/`; lazy-imported by `src/cli/state.ts` only when the
  interactive verb actually needs them. Static-CLI cold start
  (`mu task close`, `mu agent spawn`, `mu state --json`, …) does
  NOT touch any of them — `time mu task list -w …` is byte-for-byte
  unchanged.

### Changed

- **Bare `mu` (no verb) in a TTY now opens the interactive TUI**
  instead of printing the static mission card. Non-TTY callers
  (pipes, CI, sub-shells), `--json` callers, and explicit
  `mu state --mission` keep the previous static-card behaviour, so
  every scripted use of mu is unaffected. The mission card itself
  is still the canonical short glance for non-interactive shells
  and tmux status-bar pipes.

- **Pillar amendment — VISION.md Constraint #7 (NEW).** Names the
  "every invocation is short-lived" pillar explicitly for the first
  time and carves a single bounded exception class for interactive
  *readers*: `mu log --tail` (existing) and the new TUI mode.
  Bounded by four shared properties (interactive not daemon, read-
  only against SQLite, no resources beyond stdio + poll timer,
  TTY-gated with static fallback). Constraint #6 (polling-based
  subscriptions) is unchanged. See
  [docs/VISION.md](docs/VISION.md) for the full text.

- **Pillar amendment — ROADMAP.md render-layer pledge.** The
  "no render layer beyond `cli-table3` + `picocolors`" anti-feature
  bullet is REPLACED (not retired) with a tighter version that
  permits `ink` confined to `src/tui/`, lazy-imported, and gated on
  `process.stdout.isTTY` + absence of `--json`. A sibling pledge —
  "no second render layer in the TUI subtree" — closes the natural
  creep door (no `blessed`/`terminal-kit`/hand-rolled-ANSI alongside
  ink; replace the stack and amend the pledge instead of stacking
  stacks). See [docs/ROADMAP.md](docs/ROADMAP.md) for the full text.

### Removed

- **`mu state --hud`** (added 0.3.0 in `merge_state_into_hud_render_mode`).
  Replaced by the interactive TUI mode above. The `--hud` flag, the
  HUD-specific `-n`/`--lines` option (pre-flag count for the recent-
  events table that only `--hud` consumed), the greedy top-down
  budget renderer (`renderHudMode` in `src/cli/state.ts`), the
  `hudPaneSize` helper + `MU_HUD_FORCE_SIZE` env override, the four
  HUD-specific table renderers (`formatHud{Agents,Tasks,Recent,
  Tracks}Table`), and the cli-table3 `wordWrap:false` HUD trick are
  all gone. Net `~360` LOC removed from `src/cli/state.ts`. Update
  tmux configs accordingly: `tmux display-popup -E 'mu state --hud
  -w X'` becomes `tmux display-popup -E 'mu -w X'` (the new
  interactive default in a TTY) — or stay on the static card with
  `tmux display-popup -E 'mu state -w X'` if the popup wraps a
  non-TUI use case. Pre-1.0; no deprecation shim.

NEXT (for the task that consumes this draft):
- Apply verbatim above the [0.3.2] header in CHANGELOG.md.
- Set the date when the release commit lands.
- Cross-link: USAGE_GUIDE's "TUI keymap" section anchor + the
  ROADMAP amend's "no second render layer" bullet.
- Confirm `npm run typecheck && npm run lint && npm run test &&
  npm run build` clean before the release commit.

VERIFIED:
- Brief's seven asks each accounted for:
  (1) version header → 0.4.0 with three-reason justification above ✓
  (2) sections match existing voice (Added / Changed / Removed) and
      pillar amendments folded into Changed as ONE-LINE entries
      rather than inventing a new section header ✓
  (3) Added covers TUI verb + four v0 cards + keymap summary +
      link to USAGE_GUIDE ✓
  (4) Changed covers bare-`mu`-in-TTY shift ✓
  (5) Removed covers `--hud`, `-n`/`--lines`, and the rest of the
      HUD-only surface flagged in `audit_state_ts` (renderHudMode,
      hudPaneSize, MU_HUD_FORCE_SIZE, the 4 HUD table renderers) ✓
  (6) ONE-LINE pillar amendments for VISION (Constraint #7) +
      ROADMAP (render-layer pledge replacement), each linking to
      its doc ✓
  (7) New deps named (ink + react + react-reconciler + yoga-layout-
      prebuilt) and lazy-import / cold-start unchanged confirmed ✓
- Length sanity: draft is shorter than the 0.3.0 entry and on par
  with 0.3.1 — release-log voice, not tutorial. ✓
- Vocabulary cross-checked vs design_locked / docs_vision_amend /
  docs_roadmap_amend / design_global_keymap notes: TUI, interactive,
  TTY-gated, static fallback, single-popup invariant, yank-and-exit,
  short-lived. No drift.
- CHANGELOG.md was NOT edited (scope guard: read-only DRAFT role).

ODDITIES:
- The brief lists "Pillar amendments" as a section name; existing
  CHANGELOG voice has no such section. Resolved by folding them into
  Changed with a `Pillar amendment —` prefix per bullet (skimmable,
  doesn't invent a header). If the consuming task prefers a separate
  section header, two bullets lift cleanly into one.
- Date is left as `2026-05-1X` — the release wave hasn't shipped;
  the consumer fills in the actual date at commit time.
- The HUD-removal bullet doubles as a tmux-config migration note
  (the only recipe in the draft). 0.3.0's symmetric `mu hud` →
  `mu state --hud` removal did the same; voice match.
- `MU_HUD_FORCE_SIZE` env var being removed is mentioned as part
  of the HUD surface deletion. If anyone depends on it for testing,
  they'll see it gone at first run; the TUI's own size override
  (e.g. `MU_TUI_FORCE_SIZE` if needed) is a separate decision and
  not part of v0.
- Did NOT mention `investigate_bundle_size` (still OPEN) or any
  TUI test harness — those are pre-release tasks, not user-facing
  release-note material.
- Did NOT add a `Breaking` subsection. Pre-1.0 minor bumps in this
  CHANGELOG put breaking removals under `Removed` (see 0.3.2's
  pre-v0.3 export detection); only API-shape breaks ride under
  `Breaking` (see 0.3.2's `mu task wait --json` envelope). The
  `--hud` removal matches the former pattern.
```

### #2 by "scout-1", 2026-05-11T11:04:28.634Z

```
CLOSE: CHANGELOG entry drafted in note; version bump justified (0.4.0; --hud removal + bare-mu TTY shift + 2 pillar amendments)
```
