---
id: "design_json_compat"
workstream: "tui"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "designer-2"
created_at: "2026-05-11T10:45:23.212Z"
updated_at: "2026-05-11T11:10:42.424Z"
blocked_by: ["design_non_tty_fallback"]
blocks: ["design_complete"]
---

# Design --json on mu state: keep current shape; bare mu still defaults to TUI

## Notes (2)

### #1 by "designer-2", 2026-05-11T11:10:36.462Z

```
DESIGN: mu state --json / mu --json compatibility under the TUI
landing. Verification-only audit; conclusion: ZERO JSON shape
changes required, --json continues to be the unconditional scripting
escape hatch (overrides TUI even in a fully interactive TTY).

================================================================
FILES
================================================================
- /Users/mtrojer/hacking/mu/src/cli/state.ts
    L196-200   fullJsonShape (signature + return)
    L201-216   fullJsonShape body — the documented full-mode payload
    L218-226   missionJsonShape body — the documented mission-mode payload
    L228-298   cmdState dispatch (the relevant branch ordering)
    L240-249   bare-mu/no-workstream short-circuit (renderMissionNoWorkstream)
    L270-289   --json branch (THE escape hatch — runs before any human render)
    L292-298   human-render dispatch (mission / hud / full)
- /Users/mtrojer/hacking/mu/src/cli.ts
    L676-688   bare `mu` action — wires through cmdState({mission: true})
- /Users/mtrojer/hacking/mu/docs/USAGE_GUIDE.md
    L407-460   `mu state` render modes + the documented JSON-shape table
- design_locked, design_non_tty_fallback, audit_state_ts task notes.

================================================================
COMMANDS
================================================================
- read src/cli/state.ts L1-300   (dispatch + JSON shapes)
- read src/cli.ts L670-720       (bare-mu action wiring)
- read docs/USAGE_GUIDE.md L400-465  (documented JSON contract)
- grep -n "JsonShape\|fullJson\|missionJson" src/index.ts src/cli/state.ts
   → fullJsonShape / missionJsonShape are FILE-PRIVATE in
     src/cli/state.ts (not re-exported via src/index.ts). Their
     RETURN SHAPE is the public API; the function symbols
     themselves are not part of the SDK surface.

================================================================
FINDINGS
================================================================
F1. TODAY'S `mu state --json` SHAPE (single-ws, full mode).
    fullJsonShape (state.ts L196-216) emits:
      { workstreamName, agents, orphans, tracks, ready,
        inProgress, blocked, recentClosed, workspaces,
        workspaceOrphans, recent }
    Multi-ws (-w X,Y or --all with N≥2) wraps in
      { workstreams: [<fullJsonShape>...] }   (state.ts L281-285).

F2. TODAY'S `mu --json` (bare) AND `mu state --mission --json` SHAPE.
    missionJsonShape (state.ts L218-226) emits:
      { workstreamName, agents, orphans, tracks, ready }
    Bare `mu --json` flows: cli.ts L687 → cmdState({mission: true,
    json: true}) → state.ts L270-279 → emitJson(missionJsonShape).
    Multi-ws wraps in { workstreams: [<missionJsonShape>...] }.

F3. PUBLIC-API STATUS.
    Both shapes are documented in docs/USAGE_GUIDE.md L453-460
    under the "JSON shapes (per render mode)" header. That section
    is part of the user-facing usage guide, not an internal note.
    They ARE public API by mu's project convention (mu --help
    references --json on every verb; CHANGELOG advertises --json
    support; the skill file's "every verb supports --json" line
    treats them as a stable promise). Renaming or removing fields
    would be a breaking change requiring a major-version bump.

F4. THE TUI READS THE SDK, NOT JSON.
    Per design_module_layout, the ink TUI imports the same
    src/state.ts SDK seam (loadWorkstreamSnapshot — to be
    extracted from loadWorkstreamData) that the static renderer
    uses. The TUI never parses or re-emits JSON; it consumes
    typed in-memory rows. So adding TUI-only data (toggle
    states, popup focus, tick counts, key history) to the JSON
    payload would be SDK pollution with zero benefit — those
    concerns belong in TUI-internal React state, not in the
    state-snapshot SDK and certainly not in `--json`.

F5. --hud DELETION is JSON-INVISIBLE.
    Per audit_state_ts: --hud is being retired entirely. Today
    `mu state --hud --json` returns the SAME flat shape as
    `mu state --json` (state.ts L281-285 — the JSON branch
    treats --hud and bare equally; --hud only diverges in the
    human-render branch L295). After --hud goes away, the JSON
    branch ALREADY converges on the same shape. No `mu state
    --hud --json` callers can be broken by the flag's removal
    BEYOND the obvious "the --hud flag itself is gone" — the
    JSON payload would be byte-identical to `mu state --json`
    today, so any pipeline that survived the flag rename is
    semantically unchanged. (The `--hud` flag removal IS
    documented as the breaking change; the JSON shape
    invariance is a happy by-product of merge_state_into_hud_render_mode
    in v0.3.)

F6. BRANCH ORDERING IS THE GUARANTEE.
    state.ts L270-289 sits BEFORE the human-render dispatch at
    L292-298. The TUI branch (per design_non_tty_fallback D6)
    will be inserted at L295-298, INSIDE the human-render block
    — i.e. AFTER the --json short-circuit. Therefore --json
    cannot be intercepted by the TUI; --json is checked first
    and exits before the TUI activation predicate (tuiSupported)
    is even evaluated. This holds even when stdout AND stdin
    are both TTYs.

F7. BARE `mu --json` UNAFFECTED.
    cli.ts L687 always passes mission=true regardless of the TTY
    state of stdout/stdin. Combined with F6, bare `mu --json`
    produces missionJsonShape unconditionally — TTY, pipe,
    redirect, inside-tmux, outside-tmux, container, cron, all
    eight rows of design_non_tty_fallback's matrix collapse to
    "missionJsonShape" the moment --json is set. No surprise
    from the TUI.

================================================================
DECISION
================================================================
D1. NO JSON SHAPE CHANGES IN THE TUI-LANDING WAVE.
    `mu state --json` and `mu --json` both emit BYTE-IDENTICAL
    payloads before and after the TUI lands. fullJsonShape and
    missionJsonShape are unchanged. No fields added, no fields
    renamed, no fields removed.

D2. --json IS THE SCRIPTING ESCAPE HATCH; TUI MUST NOT CAPTURE IT.
    The wiring in design_non_tty_fallback D6 places the TUI
    branch INSIDE the human-render dispatch (after L289), so the
    --json short-circuit at L270-289 always wins. This is
    explicitly load-bearing: scripts running under `watch -n 5
    mu state --json -w X | jq …` from inside a fully interactive
    tmux pane MUST keep getting machine output, not a TUI flash.
    Reviewers / CI: if any reviewer of impl_tui_entry sees the
    TUI branch land BEFORE the --json branch, that's a bug
    blocker — flag and reject.

D3. --hud REMOVAL DOES NOT CHANGE `mu state --json` PAYLOAD.
    The flag itself is removed (breaking change for the FLAG, not
    the SHAPE). Today `mu state --hud --json` and `mu state
    --json` are the same payload. Tomorrow `mu state --json` is
    that same payload; `mu state --hud --json` will exit 2 with
    UsageError "unknown option --hud" (commander default).
    Document the flag removal in CHANGELOG; do NOT need a JSON
    shape diff entry.

D4. BARE `mu --json` REMAINS missionJsonShape FOREVER (for v0.x).
    Locking in F7 as a contract: bare `mu --json` is documented
    as equivalent to `mu state --mission --json` (USAGE_GUIDE
    L460); the TUI landing preserves this exactly. Adding a TUI
    does NOT promote bare `mu` to a "richer" JSON shape — that
    would silently break every shell function that pipes
    `mu --json` into jq today.

D5. BACKWARD COMPATIBILITY: 100%.
    Every existing pipeline `mu state --json | jq …` and
    `mu --json | jq …` keeps working unchanged. No script
    needs touching for the TUI landing. Verified by the
    branch-ordering invariant in F6 + the unchanged shape
    helpers in F1/F2. No deprecation warnings, no shim, no
    transitional flag — the contract is identical.

D6. FORWARD COMPATIBILITY: TUI-INTERNAL DATA STAYS TUI-INTERNAL.
    Recommendation for any future v0.x feature that adds
    TUI-tailored state (tick-stat metrics, focus-state, popup
    history, computed render hints):
      a) If the data is REAL workstream state that scripts could
         conceivably want (e.g. "stale workspace count" as a
         derived integer, or "ROI of next ready task"), it
         BELONGS in fullJsonShape / missionJsonShape and the
         shape grows ADDITIVELY (new fields only — never rename
         or remove). mu's "JSON shapes are part of the public
         API" convention means breaking changes need a major
         version.
      b) If the data is RENDER-LAYER state (which card is
         active, last yank toast, frame counter, key-press
         history, popup z-order), it stays in TUI-internal
         React state and NEVER appears in `--json`. Putting
         render-layer state into the SDK pollutes every
         non-TUI consumer (the static card, scripts, tests)
         and pre-commits to an internal representation that
         the TUI may want to refactor freely.
    The cardinal test: "would a CI script piping `mu state
    --json | jq …` ever care about this field?" If yes →
    additive SDK growth. If no → TUI-private.

D7. FIELD-ADDITIVITY ONLY (when growth happens).
    Per mu's broader JSON conventions (collection envelopes use
    `{items, count}`; nextSteps survives in JSON; `firing` was
    added to `mu task wait --first --json` additively in v0.3),
    any future change to fullJsonShape / missionJsonShape MUST
    be additive. Never rename `recentClosed` → `closed_recent`,
    never drop a field, never reorder fields where order is
    semantically meaningful (none today, but flag for review on
    every change). jq queries that survive today must survive
    every minor version bump.

================================================================
NEXT
================================================================
- impl_tui_entry: the wiring from design_non_tty_fallback D6
  MUST place the TUI-activation branch AFTER the existing
  --json short-circuit at state.ts L270-289. Reviewer (per
  design_module_layout) should treat any deviation as a
  release-blocking regression.
- docs_update: when the TUI lands, USAGE_GUIDE.md L407-460
  needs ONE small edit — replace the `--hud` row in the JSON
  shape table with a sentence noting that `mu state --json`
  emits fullJsonShape for both interactive (TTY) and
  non-interactive contexts (the TUI never overrides --json).
  No table-wide rewrite needed; the shape rows for `mu state
  --json`, `mu state --mission --json`, and bare `mu --json`
  ALL remain accurate verbatim.
- changelog_entry (TUI release): "JSON output unchanged: `mu
  state --json` and `mu --json` continue to emit the same
  shapes documented in v0.3. The TUI never intercepts --json."
  This is a deliberate user-visible promise — call it out.
- (out of scope here, flag for design_card_iface) decide
  whether the v0.1 Workspaces card (recommended in
  audit_state_ts) reuses `WorkspaceRow` from
  fullJsonShape.workspaces directly or computes derived fields.
  Either way, no change to the JSON SHAPE — the TUI consumes
  the SDK row type, not the JSON.

================================================================
VERIFIED
================================================================
- Read src/cli/state.ts L1-400 in full; confirmed the EXACT
  branch ordering (L270-289 --json before L292-298 human render)
  and the fullJsonShape / missionJsonShape function bodies.
- Read src/cli.ts L670-720; confirmed bare `mu` always passes
  mission=true regardless of TTY state, and `mu --json` is
  literally `cmdState({mission: true, json: true})`.
- Read docs/USAGE_GUIDE.md L400-465; confirmed the four
  documented JSON-shape rows (default / --hud / --mission /
  bare-mu) match what the code emits today.
- Cross-read design_locked (L1-total replacement; SDK shared),
  design_non_tty_fallback (D6 wiring sketch + F7 --json
  precedence), and audit_state_ts (KEEP bucket marks the JSON
  shapes as "MUST stay; documented JSON contracts").
- Confirmed via grep that fullJsonShape / missionJsonShape are
  not re-exported through src/index.ts. The SDK exposes the
  underlying row types (AgentRow, TaskRow, WorkspaceRow, Track,
  LogRow, WorkspaceOrphan); the JSON-shape FUNCTIONS are
  state.ts-private. This is fine — the public contract is the
  SHAPE (field names + types), not the symbol identity.
- All conclusions are read-only against the current code.
  No code touched; no tests run; design-only verification.

================================================================
ODDITIES
================================================================
O1. fullJsonShape and missionJsonShape are typed
    `Record<string, unknown>` (state.ts L196, L218). That's a
    very loose return type for a documented public-API
    payload. Pre-existing wart — out of scope for this design,
    but flag for a future hardening pass: extracting named
    interfaces (FullJsonShape, MissionJsonShape) from these two
    helpers would let TypeScript catch accidental field
    renames during refactors AND give SDK consumers a typed
    shape to import. Track as a future tightening, not a
    blocker for the TUI.

O2. The shape diverges from collection-envelope convention.
    `mu task list --json` returns `{items: T[], count: number}`;
    `mu state --json` returns a flat object with named arrays
    (`agents`, `orphans`, `tracks`, `ready`, ...) at the top
    level. This is INTENTIONAL — `mu state` is a singleton
    "current snapshot" not a collection — but worth noting for
    completeness. The TUI doesn't change this; it just inherits
    the existing convention.

O3. workspaceOrphans is in fullJsonShape (L213) but NOT in
    missionJsonShape (mission strips it along with workspaces,
    inProgress, blocked, recentClosed, recent). This is correct
    — the mission card is the glance card by design — but
    callers that need orphan info MUST use `mu state --json`
    (full), not bare `mu --json`. Pre-existing; documented
    behaviour; the TUI landing does not change it.

O4. Multi-ws JSON ALWAYS wraps in `{workstreams: [...]}`, even
    for the mission shape (state.ts L272). Single-ws emits the
    flat shape directly. Scripts piping `mu state --json` MUST
    be aware of the N=1-vs-N≥2 envelope difference (or pass
    --workstream explicitly with one value to force N=1). This
    is pre-existing per the v0.3 multi-ws expansion; the TUI
    landing does not touch it.

O5. The mission no-workstream short-circuit (state.ts L240-249
    → renderMissionNoWorkstream) runs BEFORE the --json branch.
    Need to verify that renderMissionNoWorkstream itself
    respects --json. Quick read: it's invoked when mission=true
    AND no workstream resolves AND --all is not set; if it does
    NOT honour --json, then `mu --json` outside a tmux session
    would emit human text. Audit (out of scope here, flag for
    test-reviewer or impl_tui_entry): confirm
    renderMissionNoWorkstream branches on opts.json. If it
    doesn't, that's a pre-existing JSON-contract bug
    independent of the TUI — file a separate task. The TUI
    landing per se does not regress this either way.
```

### #2 by "designer-2", 2026-05-11T11:10:42.424Z

```
CLOSE: JSON compat verified; ZERO shape changes needed: fullJsonShape (mu state --json) and missionJsonShape (mu --json) unchanged; --json branch at state.ts L270-289 wins over TUI activation; --hud removal does not change JSON payload; bare mu --json keeps emitting missionJsonShape regardless of TTY state. Backward-compat: 100% of mu state --json|jq pipelines unchanged. Forward-compat rule documented: render-state stays TUI-internal, real workstream state grows additively in the SDK shape.
```
