---
id: "investigate_render_lib"
workstream: "tui"
status: CLOSED
impact: 80
effort_days: 1
roi: 80.00
owner: "scout-1"
created_at: "2026-05-11T10:44:45.457Z"
updated_at: "2026-05-11T10:58:23.794Z"
blocked_by: ["design_locked"]
blocks: ["design_module_layout", "docs_roadmap_amend", "investigate_bundle_size"]
---

# Investigate ink + alternatives, lock render lib

## Notes (2)

### #1 by "scout-1", 2026-05-11T10:58:18.984Z

```
FILES:
- /Users/mtrojer/hacking/mu/docs/VISION.md (skimmed — small/typed/no-anticipatory pillars)
- /Users/mtrojer/hacking/mu/docs/ROADMAP.md:72 (the "no render layer beyond cli-table3+picocolors" pledge)
- /Users/mtrojer/hacking/mu/package.json (current deps: better-sqlite3, cli-table3, commander, execa, picocolors, zod — 6 runtime deps)
- mu task notes design_locked -w tui (locked decisions: keyboard-only, 1-9 toggle, Shift+1-9 popup, j/k nav, 1s poll, yank-not-execute)

COMMANDS:
- npm view ink|blessed|neo-blessed|reblessed ... → HTTP 503 (registry unreachable in this sandbox)
- curl -sL https://registry.npmjs.org/<pkg>/latest → HTTP 000 (no egress)
- ls node_modules | grep -iE 'ink|blessed' → none installed
- Decision falls back to prior knowledge of these libs + the locked design constraints

FINDINGS — CANDIDATE COMPARISON:

(1) ink (vadimdemedes/ink, React-for-terminal)
  - Maintenance: actively maintained, multiple releases per year, v5 ESM-only is current. TS types ship FIRST-PARTY (no @types/* shim).
  - Mental model: React functional components + hooks (useInput, useFocus, useApp, useStdout). Yoga flexbox layout.
  - Mouse: NOT built-in. Keyboard via useInput is excellent and matches L1/R1 (keyboard-only, model drives the CLI).
  - Scroll/focus/popup: not provided as widgets — composed from primitives. For our v0 (4 cards + 1 popup) this is fine; ink-text-input / ink-select-input / ink-spinner / ink-table cover the rest.
  - Battle-tested in our exact niche: Claude Code, Gemini-CLI, GitHub Copilot CLI, Wrangler, Prisma init, create-* wizards. Lots of prior art for "dashboard with cards" + "fullscreen popup" patterns.
  - Bundle: ink + react + react-reconciler + yoga-layout (wasm) ≈ ~250–400 KB minified ESM, ~1 MB on disk incl deps. Heavy for a CLI — but easy to lazy-import behind the `mu` interactive verb so static `mu state`, `task close`, `spawn` etc. stay cold-start cheap.
  - Pillar fit: declarative, typed, no class hierarchy. New deps: ink + react + react-reconciler + yoga-layout-prebuilt (transitively). Counts as ~1 conceptual dep ("ink") even if 4 packages.

(2) blessed (chjj/blessed)
  - Maintenance: effectively abandoned; last meaningful release ~2017. README still references Node 0.x.
  - TS: NO first-party types; @types/blessed on DefinitelyTyped is stale and incomplete (key event types lie).
  - Mouse/scroll/focus/popup: built-in widgets are its strength — Box, List, ScrollableBox, Form, native mouse, native focus ring.
  - Bundle: small core, but pulls in `term.js`, `pty.js`-style legacy. ESM-hostile (CommonJS-only); would force a wrapper or break our `"type": "module"` story.
  - Pillar fit: BAD. Untyped (violates strict + noUncheckedIndexedAccess intent), CJS-only (violates "ESM only" convention in AGENTS.md), abandoned (drift risk + we'd own every bug forever), large API surface = anticipatory abstractions we'd never use.

(3) neo-blessed (Eugene Ivanov fork)
  - Bug-fix fork of blessed circa 2017–2019, also dormant in recent years.
  - Same TS / ESM / abandonment problems as blessed; just a slightly less broken snapshot.
  - No reason to pick it over blessed unless we needed a specific fix; we don't.

(4) reblessed (community TS rewrite of blessed)
  - Smaller, more recent attempt to bring blessed forward with TS + ESM.
  - Tiny community, few real users, maintenance velocity unclear, ecosystem ≈ zero (we'd port any helper widgets ourselves).
  - High risk for a v0 we want to ship soon. Could be revisited later if ink fails us.

(5) Hand-rolled ANSI on top of picocolors
  - Pillar-pure (zero new deps) and matches the "small" pillar in spirit.
  - But for the locked design we'd need to implement: cursor save/restore, alt-screen enter/exit, full-buffer diff to avoid flicker, key-decoder (CSI sequences for arrows / Shift+digit / Esc / mouse if ever), responsive layout for the 4-card dashboard, scrollable list virtualization for the activity log + notes popup, focus model, popup z-order.
  - That's a layout engine + an input decoder + a renderer. Easily 1500–3000 LOC of fragile terminal trivia, all of which ink already has and nobody on the team has to maintain. Violates "ship the smallest thing that works" the moment v0 grows a second card type.

SCORING (5=best):
| Criterion             | ink | blessed | neo-blessed | reblessed | hand-rolled |
|-----------------------|-----|---------|-------------|-----------|-------------|
| Maintenance health    |  5  |   1     |     1       |    2      |     5*      |
| TS types              |  5  |   2     |     2       |    4      |     5       |
| Mouse/scroll/focus    |  3  |   5     |     5       |    4      |     1       |
| Popup support         |  4  |   4     |     4       |    3      |     1       |
| Bundle size           |  2  |   4     |     4       |    4      |     5       |
| Project-values fit    |  5  |   1     |     1       |    2      |     3       |
| Ecosystem / prior art |  5  |   3     |     2       |    1      |     0       |
* hand-rolled is "maintained by us, forever"

DECISION: **ink**.

Tie-breakers, in order:
1. The keyboard-only, yank-not-execute design (R1) erases ink's only real weakness vs blessed (no native mouse). We don't need mouse.
2. First-party TS types are non-negotiable for a strict-mode + noUncheckedIndexedAccess + verbatimModuleSyntax codebase. Only ink and (partly) reblessed clear this bar; blessed/neo-blessed don't.
3. ESM-only is the codebase rule (AGENTS.md). ink is ESM-native; blessed forks are CJS or hybrid.
4. Same-niche prior art: Claude Code / Gemini-CLI / Copilot-CLI all use ink. Risk is well-understood; idioms are public.
5. Bundle size is the real cost. Mitigation: lazy-import the TUI module from `cli/state.ts` only when the interactive verb is invoked; static `mu state`, `mu task close`, `mu agent spawn` etc. never touch ink. Static fallback keeps using cli-table3+picocolors. Worst case: ~1 MB on disk in node_modules, which is small next to better-sqlite3's native binary.

Pillar amendment required (already flagged in design_locked):
- "No render layer beyond cli-table3 + picocolors" → "+ ink for the interactive `mu` TUI; cli-table3+picocolors remain the only renderers for non-TTY/CI output." That's the docs_roadmap_amend / docs_vision_amend deliverable.

Cost ledger (for the amendment text):
- +1 conceptual dep (ink), ~3 transitive (react, react-reconciler, yoga-layout-prebuilt). Counted as "1 render layer for interactive mode" against the pledge.
- Lazy-loaded; non-TUI cold-start unchanged.
- TUI is ≤1 module subtree (e.g. src/tui/) consuming the same SDK as the static renderer — drift risk bounded by shared SDK.

NEXT:
- design_module_layout: src/tui/ subtree (per AGENTS.md "one level of subdirs OK"); single entry point lazily imported by src/cli/state.ts; components per card.
- docs_roadmap_amend: rewrite the pledge line at ROADMAP.md:72 as above.
- investigate_bundle_size: actually `npm i ink react` in a scratch dir and measure `du -sh node_modules/{ink,react,react-reconciler,yoga-layout-prebuilt}` + a tsup bundle of a "hello world TUI" to confirm the ~250–400 KB minified estimate.
- Worth piloting: ink-text-input (footer command line if we ever go beyond yank), ink-spinner (poll-tick indicator). Defer until a v0 component actually needs them — anti-anticipatory.

VERIFIED:
- Locked design (`mu task notes design_locked -w tui`) confirms keyboard-only + single-popup + 1s poll, which is the assumption ink rests on.
- ROADMAP.md:72 confirms the pledge that needs amending.
- AGENTS.md confirms strict TS + ESM-only + 1500 LOC/file caps that disqualify the blessed family on type/ESM grounds alone.

ODDITIES:
- npm registry was unreachable from this sandbox (HTTP 503/000), so the "last release date" / "open issues" numbers in this note are from prior knowledge rather than a live fetch. The pillar-fit and design-fit arguments don't depend on those numbers; investigate_bundle_size should re-confirm versions/dates when network is available.
- Did NOT consider: ratatui-bindings / tui-rs ports (Rust, wrong runtime), terminal-kit (active but smaller TS story, similar trade-offs to blessed), neo-neo-blessed / opentui / etc. — all outside the brainstorm shortlist and none clear ink on the criteria above.
```

### #2 by "scout-1", 2026-05-11T10:58:23.794Z

```
CLOSE: decision: ink; reasons summarized in note (TS-first-party + ESM-native + same-niche prior art + design is keyboard-only so ink's no-mouse weakness is moot; blessed family disqualified on TS/ESM/abandonment; hand-rolled disqualified on LOC cost). Pillar amendment confirmed required (ROADMAP.md:72).
```
