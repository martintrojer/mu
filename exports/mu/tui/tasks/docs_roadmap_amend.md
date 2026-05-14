---
id: "docs_roadmap_amend"
workstream: "tui"
status: CLOSED
impact: 80
effort_days: 0.5
roi: 160.00
owner: "scout-1"
created_at: "2026-05-11T10:45:23.759Z"
updated_at: "2026-05-11T11:01:43.407Z"
blocked_by: ["design_locked", "investigate_render_lib"]
blocks: ["design_complete", "docs_changelog"]
---

# Draft ROADMAP.md amendment: retire 'no render layer beyond cli-table3' pledge

## Notes (2)

### #1 by "scout-1", 2026-05-11T11:01:40.937Z

```
FILES:
- /Users/mtrojer/hacking/mu/docs/ROADMAP.md (pledge L72; whole pledge block L48-83)
- /Users/mtrojer/hacking/mu/docs/VISION.md (designer-2 amends Constraint #6→#7 in sibling task)
- mu task notes design_locked          -w tui  (locked decisions; pillar tensions named)
- mu task notes investigate_render_lib -w tui  (ink decision + cost ledger)
- mu task notes docs_vision_amend      -w tui  (designer-2's parallel draft; vocabulary source)

COMMANDS:
- grep -n "render layer" docs/ROADMAP.md → L72 (single occurrence; clean to amend)
- grep -nE "ink|TUI|interactive" docs/ROADMAP.md → no other references; this is the ONLY edit needed
- Cross-read of designer-2's vision amend to align vocabulary (predicates, "interactive readers")

FINDINGS:

1. ROADMAP.md L72 is the only place the render-layer pledge appears.
   Amendment is a single-line surgical edit; no cross-references to fix
   elsewhere in ROADMAP. (VISION.md amendment is the sibling task's job.)

2. Designer-2's vision draft frames the TUI as a SECOND MEMBER of an
   existing exception class ("interactive readers") that already
   includes `mu log --tail`, bounded by four properties:
     (a) interactive, not a daemon (dies with its owner)
     (b) read-only against SQLite (mutations yank-and-exit)
     (c) no resources beyond stdout/stdin/poll-timer
     (d) TTY-gated with static fallback
   This framing is good. The ROADMAP amendment uses the SAME vocabulary
   ("TUI subtree", "static fallback", "lazy-imported", TTY gate as the
   activation predicate) so the two docs read as one decision, not two.

3. The original pledge ("Add a render layer beyond cli-table3 +
   picocolors") is pledge-shaped: a clean refusal. Drift risk is real
   if we replace it with a vague hedge ("ink is allowed for TUI stuff").
   The replacement below is TIGHTER than the original because it names
   THREE bounding predicates that the original didn't have to: subtree
   confinement, lazy-import, and TTY-gated activation.

DECISION — PLEDGE AMENDMENT (drop-in for ROADMAP.md L72):

----- BEFORE (single line, L72) -----
- Add a render layer beyond `cli-table3` + `picocolors`.
----- AFTER (replace L72 with the following two bullets) -----
- Add a render layer beyond `cli-table3` + `picocolors`, EXCEPT
  `ink` confined to the interactive TUI subtree (`src/tui/`),
  lazy-imported by `mu` / `mu state` only when `process.stdout.isTTY`
  is true and `--json` is absent. The static `mu state` fallback,
  `mu task list`, `mu agent show`, and every other verb keep
  rendering with `cli-table3` + `picocolors`. `ink` (and its
  transitive `react` / `react-reconciler` / `yoga-layout-prebuilt`)
  MUST NOT be imported from any module outside `src/tui/`; lint /
  typecheck enforce the boundary. The TUI is the only long-lived
  process mu ships; everything else stays short-lived.
- Add a SECOND render layer inside the TUI subtree. One stack,
  period: no `blessed` / `neo-blessed` / `reblessed` /
  `terminal-kit` alongside `ink`, no second React-for-CLI library,
  no hand-rolled ANSI renderer running in parallel. If a future
  need outgrows `ink`, REPLACE the stack and amend this pledge —
  don't stack stacks. (The "well, ink for some popups, blessed for
  others" creep is exactly the kind of accumulation this list
  exists to refuse.)
----- END AFTER -----

CROSS-CHECK vs designer-2's docs_vision_amend (consistency audit):

- Vocabulary: ✓ both use "TUI" (not "HUD" — `--hud` is replaced per
  design_locked), "interactive", "TTY-gated", "static fallback",
  "long-lived" / "short-lived". No drift.
- Bounding predicates: VISION lists four (interactive / read-only /
  no-extra-resources / TTY-gated). ROADMAP states three of the
  four explicitly (subtree confinement, lazy-import, TTY-gated +
  --json gate). Read-only is not a render-layer concern so it's
  correctly absent from the ROADMAP pledge — it lives in VISION
  where lifecycle pillars belong. No contradiction; the two docs
  carry complementary halves of the same fence.
- "Interactive readers" exception class: VISION names the class
  and lists `mu log --tail` as the existing member. ROADMAP does
  not need to repeat the class definition; it just enforces the
  render-layer half of the boundary. Linking via "the TUI is the
  only long-lived process mu ships" matches VISION's "deliberately
  and narrowly exempt".
- DRIFT FLAGGED: none. (One micro-drift considered and rejected:
  VISION says "a third member of this exception class would need
  its own promotion"; ROADMAP says "REPLACE the stack and amend
  this pledge — don't stack stacks". These are about different
  axes — VISION is about adding new long-lived verbs; ROADMAP is
  about adding new render layers — and they don't overlap.)

NEW ANTI-FEATURE PLEDGE (the second bullet above, restated for
the commit message): "No second render layer in the TUI subtree."
This pre-empts the natural creep ("ink for the dashboard, blessed
for one popup that needs scroll-in-scroll", "ink for layout,
terminal-kit for input handling"). One stack, replace not stack.

COMMIT-MESSAGE PARAGRAPH (for the consuming task to drop into its
commit body, quoting the cost ledger from investigate_render_lib):

> ROADMAP: amend "no render layer beyond cli-table3 + picocolors"
> to permit `ink` confined to the interactive TUI subtree
> (`src/tui/`), lazy-imported only when stdout is a TTY. Cost
> ledger from investigate_render_lib (recorded as a task note on
> 2026-05-11): +1 conceptual dep (`ink`), ~3 transitive
> (`react`, `react-reconciler`, `yoga-layout-prebuilt`); ~1 MB on
> disk in node_modules; lazy-imported so non-TUI cold start is
> unchanged; static `mu state` fallback unchanged; `mu task list`,
> `mu agent show`, every other verb keep rendering through
> `cli-table3` + `picocolors`. The pledge is REPLACED, not
> retired: subtree confinement + lazy-import + TTY-gated
> activation are tighter constraints than the original line had,
> and a new sibling pledge ("no second render layer in the TUI
> subtree") closes the obvious creep door before it opens. This
> commit's render-layer amendment is the ROADMAP half of the
> pillar work; the VISION half (naming the short-lived-process
> pillar and listing the TUI alongside `mu log --tail` as a
> bounded interactive reader) lands in a sibling task.

SECOND-ORDER CONCERNS (and how the amendment pre-empts them):

1. "If `ink` is OK, is `react-router-cli` OK?"
   No. The pledge permits `ink`, BY NAME, as the render layer.
   Routing libraries / form libraries / state-management libraries
   are not render layers; they're additional abstractions and fall
   under the existing "no abstractions for future flexibility"
   pledge above (and the locked design's 4-cards + 1-popup +
   1-9/Shift+1-9 keymap doesn't need a router — the entire app
   state is one toggle bitmask + one popup-id slot). Worth a
   one-liner in any future PR that proposes such a dep.

2. "Is `ink-table`, `ink-spinner`, `ink-text-input` a 'second
   render layer'?"
   No — those compose WITH `ink` (they ARE `ink` components
   published separately), they don't render in parallel. They
   count against the original "small" pillar individually and
   should be added one-at-a-time only when a v0 component
   actually needs them (anti-anticipatory; per
   investigate_render_lib NEXT). They do NOT trip the
   no-second-render-layer pledge.

3. "Doesn't permitting `ink` weaken 'no anticipatory abstractions'
   given the locked design has only 4 cards?"
   No: 4 cards × 1 popup × ~1-2 sub-components each is already
   well past the LOC threshold where hand-rolled ANSI becomes
   maintenance-of-flicker-and-key-decoders. The justification is
   "ship the smallest thing that works" — ink IS smaller, in net
   LOC we own, than the alternative.

4. "Could a future caller import `ink` outside `src/tui/` to add a
   one-off animated spinner to `mu spawn`?"
   The pledge text says MUST NOT and asks lint/typecheck to
   enforce. Implementation hook for the consuming task:
   biome's `noRestrictedImports` (or a one-line tsup external)
   forbidding `ink*` imports from anywhere except `src/tui/**`.
   If that lint hook is too cute, a comment in `src/cli/state.ts`
   above the dynamic `import("../tui/index.js")` saying "this is
   the only place ink may be imported" is the cheap fallback.

5. "What about `mu log --tail`'s rendering — does it stay on
   picocolors?"
   Yes. `mu log --tail` is line-oriented NDJSON / colored-line
   output; it neither needs nor wants ink. Only the TUI verb
   touches ink. This is implicit in "lazy-imported by `mu` /
   `mu state` only" but worth keeping in mind for the consuming
   task in case anyone reads the amendment as "all interactive
   readers may use ink".

NEXT (for the task that consumes this note):
- Apply the BEFORE/AFTER edit to docs/ROADMAP.md L72 verbatim.
- Use the COMMIT-MESSAGE PARAGRAPH above as the body; subject
  line e.g. "ROADMAP: permit `ink` in TUI subtree; refuse second
  render stack".
- Verify: typecheck + lint + tests + build clean (this is a
  docs-only change so all four should be no-ops, but the
  acceptance test should still pass).
- Coordinate ordering with docs_vision_amend's consuming task:
  either commit can land first; the two amendments don't share
  any line and reference each other only by topic, not by line
  number. Sibling task's note already says "ROADMAP's separate
  pledge is amended in a sibling task; this commit does not touch
  ROADMAP.md" — symmetry holds.

VERIFIED:
- Pledge text re-read aloud against the brief's four asks: (1)
  exact before/after ✓, (2) tighter than the original ✓ (adds
  three bounding predicates), (3) cross-check against
  docs_vision_amend done with explicit drift audit ✓, (4) new
  anti-feature pledge proposed ✓ (no second render layer in TUI
  subtree).
- ROADMAP.md was NOT edited (scope guard: read-only, draft in
  note only).
- Vocabulary consistency with VISION amend: ✓ (TUI, interactive,
  TTY-gated, static fallback, long-lived/short-lived).
- Cost ledger pulled verbatim from investigate_render_lib note
  (lazy-import, ~1 MB on disk, non-TUI cold start unchanged,
  static fallback unchanged) ✓.

ODDITIES:
- The amendment turns ONE bullet into TWO (the carve-out plus the
  new no-second-stack pledge). Both belong on the anti-feature
  list because both are "things we WILL NOT do"; the carve-out
  bullet just happens to start with an exception clause. If a
  reviewer prefers strict one-pledge-per-bullet, the carve-out
  could be split into "(a) no render layer beyond cli-table3 +
  picocolors + ink-in-TUI" and a separate "(b) ink stays in
  src/tui/" — readability tradeoff, not a substance change. I
  prefer the current shape because the carve-out and the
  confinement clause are inseparable in spirit.
- The pledge text says "lint / typecheck enforce the boundary"
  but the actual enforcement hook is the consuming task's call
  (biome noRestrictedImports vs a comment-and-trust). Listed in
  SECOND-ORDER #4 above.
- I used "subtree" rather than "directory" or "module" because
  AGENTS.md's layout rule already uses "one level of subdirs"
  vocabulary; matching it makes the boundary obvious to anyone
  who's read AGENTS.md.
```

### #2 by "scout-1", 2026-05-11T11:01:43.407Z

```
CLOSE: amendment text drafted in note; consistent with vision amend; new anti-feature pledge proposed
```
