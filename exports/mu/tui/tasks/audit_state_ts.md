---
id: "audit_state_ts"
workstream: "tui"
status: CLOSED
impact: 70
effort_days: 1
roi: 70.00
owner: "scout-2"
created_at: "2026-05-11T10:44:45.773Z"
updated_at: "2026-05-11T10:55:19.354Z"
blocked_by: ["design_locked"]
blocks: ["design_card_tracks", "design_module_layout", "design_sdk_seam"]
---

# Audit current state.ts (907 LOC) — what to keep, port, delete

## Notes (2)

### #1 by "scout-2", 2026-05-11T10:55:16.446Z

```
FILES:
- src/cli/state.ts (entire 907 LOC; key ranges below)
  - L1-89   module banner / imports
  - L93-139 PerWsData + loadWorkstreamData (the SDK seam — pure data load)
  - L141-194 resolveWorkstreamSet (-w / --all / auto; pure resolution)
  - L196-226 fullJsonShape / missionJsonShape (JSON projections)
  - L228-300 cmdState dispatch (mode routing + JSON branch)
  - L302-387 renderFullMode + renderFullCard (default `mu state`)
  - L389-456 renderMissionMode / renderMissionCard / renderMissionNoWorkstream
  - L458-741 HUD helpers: hudPaneSize, newHudTable, formatHud{Agents,Tasks,Recent,Tracks}Table,
             colorEventPayload, agentStatusHistogram
  - L743-874 renderHudMode (greedy top-down layout, height/width budgeter)
  - L876-907 wireStateCommands (commander wiring; --hud, --mission, --events, -n, --all)
- src/cli.ts L37, L676-689, L698 — bare `mu` is wired to cmdState({mission:true});
  wireStateCommands(program) registers `mu state`.
- src/cli/format.ts L39, L124, L164, L216, L237, L299, L320 — pure renderers reused
  by both static state and other verbs (formatAgentsTable, formatTracks,
  formatReadyTable, formatTaskListTable, formatWorkspacesTable, formatWorkstreamsTable,
  statusIcon, IDLE_GLYPH, printLogRow).
- src/tracks.ts — getParallelTracks already lives in SDK (good).
- src/tasks.ts, src/agents.ts, src/workspace.ts, src/logs.ts, src/workstream.ts —
  the data sources cmdState calls; already SDK.

COMMANDS:
- wc -l src/cli/state.ts src/cli.ts → 907 + 820
- grep -n "^function\|^export" src/cli/state.ts → 24 top-level symbols
- mu task notes design_locked -w tui (read locked decisions)
- mu task show audit_state_ts -w tui (confirmed scope)

FINDINGS — three buckets:

KEEP (~200 LOC of state.ts + most of format.ts; non-TTY/CI fallback):
- L302-387 renderFullMode / renderFullCard — the static `mu state` non-TTY card.
  This IS the L1-total fallback the design contract preserves. Leave intact.
- L389-456 renderMissionMode / renderMissionCard / renderMissionNoWorkstream —
  bare `mu` outside a TTY (CI, scripts, ssh into a non-tmux shell, --json
  consumers, the no-workstream discovery view). Keep all three.
- L196-226 fullJsonShape / missionJsonShape — these are the documented JSON
  contracts (`mu state --json` / `mu --json`); MUST stay. Both modes' machine
  shape is part of the public API.
- L228-300 cmdState dispatch + the `--json` branch + the `--all`/multi-ws fan-out.
  Stays as-is for non-TTY; the new TUI is a SEPARATE entry point (likely
  `mu` when isTTY → ink app, else fall through to current cmdState).
- L883-907 wireStateCommands — `mu state` keeps its commander surface;
  only the --hud option (L887, L893) is removed. --mission and --all stay.
- src/cli/format.ts entirely — all pure renderers are still used by the
  static fallback AND by every other `mu task list / mu agent list` verb.
  Do NOT touch.

PORT (~120 LOC; promote to SDK seam — candidates for new src/state.ts module):
- L93-139 PerWsData + loadWorkstreamData — this is THE SDK seam. The TUI
  needs exactly this shape per poll tick. Promote to src/state.ts as
  `loadWorkstreamSnapshot(db, ws, {eventLimit}) → WorkstreamSnapshot`.
  Both static renderer and ink TUI consume it. Pure data; no rendering.
- L141-194 resolveWorkstreamSet — pure set resolution from -w/--all/auto.
  Promote to src/state.ts (or src/workstream.ts) as
  `resolveWorkstreamSet(db, {workstream?, all?})`. Used by both surfaces;
  the TUI's poll loop needs the same canonicalization.
- L322 byRoiDesc (in cli.ts), L394 withRoiAll (in cli.ts) — already sort-of
  SDK-adjacent. Tracks card + Ready card in the TUI need ROI sort identically.
  Move to src/tasks.ts (or new src/state.ts) as pure helpers; cli.ts re-exports.
- L734-741 agentStatusHistogram — pure derivation (Map<status, count> of
  agents). Belongs next to AgentRow in src/agents.ts (or src/state.ts).
  Both static "Agents" header and TUI Agents card need this.
- L677-686 colorEventPayload — half-pure. The string segmentation
  (find verb prefix in EVENT_VERB_PREFIXES) is pure logic; the picocolors
  call is render. Split: SDK gives `classifyEventVerb(payload) → {verb, rest} | null`,
  static and TUI each colourize. EVENT_VERB_PREFIXES already lives in src/logs.ts.
- L538-733 the per-cell budget math and "ago" / truncate calls inside
  formatHud{Agents,Tasks,Recent,Tracks}Table — the COLUMN-WIDTH math is
  HUD-specific (delete) but the per-row data shaping (taskBit "—" / single /
  "⊕N", roi colour buckets at 100/50, "ready" count colouring at 0) is
  reusable. Promote those tiny derivations to SDK helpers
  (`summarizeOwnedTasks(rows)`, `roiBucket(roi) → 'high'|'mid'|'low'`).
  TUI's ink components want them; static could also adopt.
- Bucketing into ready / inProgress / blocked / recentClosed — already in
  src/tasks.ts (listReady/InProgress/Blocked/RecentClosed). No port needed;
  loadWorkstreamData is the right consumer.

DELETE (~360 LOC; --hud-specific, replaced by the TUI):
- L458-733 the HUD render machinery in full:
  - L493-513 hudPaneSize + MU_HUD_FORCE_SIZE env override (~20 LOC).
    ink owns terminal sizing; this becomes dead.
  - L515-526 newHudTable + cli-table3 wordWrap:false trick (~10 LOC).
  - L528-536 Tagged<T> / tag / wsCell helpers (~10 LOC). multi-ws unioning
    moves into ink components / SDK selectors.
  - L538-593 formatHudAgentsTable (~55 LOC). Replaced by ink Agents card.
  - L595-633 formatHudTasksTable (~40 LOC). Replaced by ink Ready card.
  - L635-674 formatHudRecentTable (~40 LOC). Replaced by ink Activity-log card.
  - L677-686 colorEventPayload — KEEP the classify half (port), DELETE the
    picocolors render path.
  - L688-732 formatHudTracksTable (~45 LOC). Replaced by ink Tracks card.
- L743-874 renderHudMode (~130 LOC) — the greedy top-down height-budget
  layout. Entirely supplanted by ink's flex layout + the design_card_iface
  toggle/popup contract. Delete.
- L161-162 StateOpts.hud + StateOpts.lines — drop hud; lines is HUD muscle-
  memory alias for --events, can drop unless --events itself stays for the
  static path.
- L231-233 the hud/mission mutual-exclusion check + L262 hud-vs-full
  default-events branch + L295-298 hud branch in cmdState — all gone.
- L883-907 wireStateCommands — DELETE the --hud and -n/--lines options
  (lines 887, 893). Update description to drop the --hud paragraph.
- src/cli.ts — no --hud reference outside state.ts (grepped); only
  `mission-control` mention in comments. No cleanup needed there.

Approx LOC breakdown of state.ts (907 total):
  KEEP   ~210   (full + mission renderers, dispatch, JSON shapes, wiring)
  PORT   ~120   (data load, resolve, JSON shapes overlap, classify/derive helpers)
  DELETE ~360   (HUD layout + 4 hud-table renderers + hud size/util + hud opts)
  Banner/imports/blank ~217 (will shrink proportionally with the deletions)

DECISION:
- The SDK seam to introduce is `src/state.ts` exporting:
    type WorkstreamSnapshot (the existing PerWsData)
    loadWorkstreamSnapshot(db, ws, {eventLimit}) → snapshot
    resolveWorkstreamSet(db, opts) → string[]
    classifyEventVerb(payload), agentStatusHistogram, summarizeOwnedTasks,
    roiBucket(roi)
- src/cli/state.ts SHRINKS to: imports from src/state.ts + the static
  full / mission render functions + commander wiring (drop --hud).
  Estimated post-shrink size: ~330 LOC (well under the 800 refactor signal
  and 1500 hard cap).
- The new TUI module (per design_module_layout) imports the same
  src/state.ts seam — zero render-logic duplication between static and ink.
- byRoiDesc/withRoiAll move from src/cli.ts to src/tasks.ts; cli.ts re-exports
  for back-compat (no churn for existing cli/* importers).

REGRESSIONS — what static `mu state` shows that the v0 TUI cards do NOT yet cover:
The TUI v0 = Agents, Tracks, Ready, Activity log (4 cards). Static `mu state`
(full mode) renders SEVEN sections. Coverage gap:
  ✓ Agents          → covered (Agents card)
  ✓ Tracks          → covered (Tracks card)
  ✓ Ready           → covered (Ready card)
  ✓ Recent events   → covered (Activity log card)
  ✗ Orphans         → NOT covered. Today rendered as a sub-block of Agents in
                      the static card (cli/state.ts L321-327 / L405-413). Could
                      tuck into the Agents card as an extra section / footer
                      line, OR add a v0.1 Orphans card. Recommend folding into
                      Agents (low surface, rare).
  ✗ In progress     → NOT covered as its own card. The Tracks card surfaces
                      activity indirectly (readyCount, owned tasks per agent in
                      Agents card via listTasksByOwner). Recommend adding
                      "in-progress count + owners" as a row in the Agents card
                      (already done by the HUD's per-agent task column) instead
                      of a 5th card.
  ✗ Blocked         → NOT covered. Today: full-mode-only section (L362-364).
                      Probably fine to drop from v0 dashboard and rely on
                      `mu task list --status BLOCKED` / Shift+1-style popup.
                      Document as accepted regression.
  ✗ Recent closed   → NOT covered. Closed-task history. Accept regression for
                      v0; closed tasks live in `mu task list --status CLOSED`
                      and the Activity log card already shows close events.
  ✗ Workspaces      → NOT covered. Today shown with stale ≥10 commits warning
                      (L368-386). HIGH-VALUE — this is a real footgun
                      (bug_workspace_stale_parent_silent_drift, mentioned in
                      mu skill). Recommend either:
                        (a) v0.1 Workspaces card (5th card, follows the same
                            toggleable contract), OR
                        (b) collapse to a single warning line in the Agents
                            card header when ANY workspace is stale.
                      Strongly suggest (a) — staleness is a polling-surface
                      concern and matches the dashboard idiom.
  ✗ Workspace orphans → NOT covered. Today: yellow warning block (L379-386).
                      Fold into the Workspaces card if added (b) above.
  ✗ no-workstream discovery view (renderMissionNoWorkstream) → out of scope
                      for the TUI (the TUI is launched only when a workstream
                      resolves; bare `mu` outside a session keeps its existing
                      static mission fallback).

Recommendation summary:
  - Add "Workspaces" as a v0.1 fifth card (slot 5; Shift+5 popup with full
    table). Single biggest regression risk if dropped.
  - Fold orphans into Agents card.
  - Accept In progress / Blocked / Recent closed as regressions; surface
    via existing CLI verbs and Shift+popup overlays.

NEXT:
- design_sdk_seam: nail down the exact src/state.ts API
  (WorkstreamSnapshot, loadWorkstreamSnapshot, resolveWorkstreamSet,
  classifyEventVerb, summarizeOwnedTasks, roiBucket).
- design_module_layout: confirm src/cli/state.ts post-shrink shape +
  where the ink TUI lives (likely src/tui/ subdir cluster).
- design_card_tracks / design_card_agents / design_card_ready / design_card_log:
  consume the SDK seam, not the renderers.
- Open question for design_card_iface: should "Workspaces" be a 5th v0 card
  or v0.1 promotion? Flagging here so the owner of design_card_iface decides.

VERIFIED:
- Read all 907 LOC of src/cli/state.ts.
- Read state-relevant ranges of src/cli.ts (L650-710), src/cli/format.ts header
  + symbol grep, design_locked notes, audit_state_ts task spec.
- Confirmed colorEventPayload + EVENT_VERB_PREFIXES live correctly in
  src/logs.ts (already SDK).
- Confirmed getParallelTracks already in src/tracks.ts (SDK).
- Confirmed src/cli/format.ts is shared by other verbs — must NOT be
  collateral damage during the HUD deletion.
- LOC counts approximate (eyeballed by symbol-range grep, not line-counted).

ODDITIES:
- byRoiDesc + withRoiAll currently live in src/cli.ts (L322, L394), not in
  src/tasks.ts where ROI conceptually belongs. Pre-existing wart;
  move during the SDK-seam extraction.
- StateOpts.lines is a -n alias for --events, justified as "hud muscle
  memory" (L162, L893). With --hud gone, --lines should also go OR be
  documented as legacy alias. Probably safe to drop.
- MU_HUD_FORCE_SIZE env var (L494) and currentPaneSize import (L80) become
  dead with the HUD deletion. Check src/tmux.ts — currentPaneSize may have
  no other callers afterwards.
- The `wsCell` / `Tagged<T>` multi-workstream union pattern (L532-536)
  is HUD-only. The static full/mission modes stack per-ws cards instead
  of unioning rows. The TUI design contract doesn't speak to multi-ws yet;
  flag for design_card_iface (out of audit scope).
- The L33-43 module banner notes the status-only refresh contract
  (skip prune+reap on every render). The TUI's poll loop MUST preserve
  this — bug_agent_spawn_workspace_fk_failure and bug_pane_title_glyph_stuck_at_needs_input
  are the receipts. Carry the constraint into loadWorkstreamSnapshot.
```

### #2 by "scout-2", 2026-05-11T10:55:19.354Z

```
CLOSE: audited; KEEP/PORT/DELETE buckets in note
```
