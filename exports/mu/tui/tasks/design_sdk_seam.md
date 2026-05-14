---
id: "design_sdk_seam"
workstream: "tui"
status: CLOSED
impact: 85
effort_days: 1
roi: 85.00
owner: "scout-2"
created_at: "2026-05-11T10:44:55.548Z"
updated_at: "2026-05-11T11:01:57.636Z"
blocked_by: ["audit_state_ts"]
blocks: ["design_card_iface"]
---

# Design SDK seam: getStateCard() and friends as the only TUI data source

## Notes (2)

### #1 by "scout-2", 2026-05-11T11:01:55.055Z

````
FILES (read for this design):
- src/cli/state.ts L52-89 (imports — what cli/state currently pulls from SDK)
- src/cli/state.ts L93-139  (PerWsData + loadWorkstreamData — the existing seam)
- src/cli/state.ts L141-194 (resolveWorkstreamSet — current location)
- src/cli/state.ts L196-226 (fullJsonShape + missionJsonShape — JSON contracts)
- src/cli/state.ts L304-387 (renderFullCard — the static fallback consumer)
- src/cli/state.ts L408-456 (renderMissionCard — the second static consumer)
- src/cli/state.ts L538-593 (formatHudAgentsTable — owns per-agent task summary)
- src/cli/state.ts L595-674 (formatHudTasksTable / formatHudRecentTable — ROI buckets, event colour)
- src/cli/state.ts L677-686 (colorEventPayload — exported, has a regression test)
- src/cli/state.ts L734-741 (agentStatusHistogram — pure derivation, HUD header only today)
- src/agents.ts   L82-111  (AgentRow + idle? field)
- src/agents.ts   L767-784 (LiveAgentsView — { agents, orphans, report })
- src/agents.ts   L784-793 (listLiveAgents signature + status-only mode contract)
- src/tasks.ts    L83-96   (TaskRow), L673-692 (listTasksByOwner)
- src/tasks/status.ts (TaskStatus enum + STATUSES_TERMINAL_OR_PARKED)
- src/tracks.ts   L30-46   (Track interface), L48 (getParallelTracks)
- src/workspace.ts L36-50  (WorkspaceRow + commitsBehindMain), L231-240 (WorkspaceOrphan), L271 (listWorkspaceOrphans), L568 (decorateWithStaleness)
- src/logs.ts     L19-33   (LogRow), L131 (listLogs), L346-... (EVENT_VERB_PREFIXES)
- src/cli.ts      L322-323 (byRoiDesc), L394-396 (withRoiAll) — ROI helpers, currently in cli.ts
- src/cli/format.ts L278-292 (printLogRow — already calls displayEventPayload, NOT colorEventPayload)
- src/index.ts    (SDK barrel — what gets re-exported publicly)

COMMANDS:
- mu task notes design_locked   -w tui   (read locked decisions)
- mu task notes audit_state_ts  -w tui   (read the prior audit; KEEP/PORT/DELETE buckets)
- mu task show  design_sdk_seam -w tui
- grep -rn "from.*cli/state"      src/ test/  →  ONE non-test consumer (src/cli.ts wires cmdState/wireStateCommands)
- grep -rn "agentStatusHistogram\|colorEventPayload" src/ test/  →  HUD-only today; one regression test on colorEventPayload in test/state-render.test.ts L395-444
- wc -l src/{agents,tasks,logs,tracks,workspace,workstream}.ts src/cli/state.ts
    800 + 1433 + 392 + 167 + 977 + 600 + 907  =  5276 LOC
- (no shell mutations; design-only role)

FINDINGS — the seam audit revisited under the pillar checks:

1. PILLAR: "no anticipatory abstractions; no traits with zero implementors".
   The audit proposed SIX exports. Re-counting consumers (static `mu state`
   non-TTY fallback + ink TUI + any incidental SDK caller):

     export                   | callers today after this lands
     -------------------------+------------------------------------------------
     loadWorkstreamSnapshot   | renderFullCard, renderMissionCard, ink useSnapshot()  →  3
     resolveWorkstreamSet     | cmdState dispatch, ink TUI launcher                    →  2
     classifyEventVerb        | ink Activity-log card  (static printLogRow does NOT
                                colour-by-verb today; only displayEventPayload-strip) →  1 ⚠
     agentStatusHistogram     | ink Agents card header                                 →  1 ⚠
     summarizeOwnedTasks      | ink Agents card row body                               →  1 ⚠
     roiBucket                | ink Ready card + ink Tracks card cells                 →  2 ✓

   Strict reading kills classifyEventVerb / agentStatusHistogram /
   summarizeOwnedTasks. But two pragmatic outs apply:

     (a) classifyEventVerb has a documented maintenance contract in
         src/logs.ts L320-345: EVENT_VERB_PREFIXES exists EXPLICITLY as
         single source of truth for the colour-by-verb path, and its
         regression test (test/state-render.test.ts L403-444) walks every
         entry. Moving the matcher next to its prefix list is co-locating
         a contract, not introducing an abstraction. Lives in src/logs.ts.

     (b) The static `mu state` Agents header could trivially adopt
         agentStatusHistogram (today shows only `(N active, M orphan)`;
         a histogram of statuses is strictly more useful) and
         summarizeOwnedTasks (today the `In progress` section lists tasks
         row-by-row but never summarises per-agent — the "what is each
         worker doing right now" glance only exists in the HUD).
         If we adopt them in static at this seam-extraction time, the
         single-caller smell goes away and the static fallback gets
         small wins. Recommended.

   That leaves the public src/state.ts at FOUR exports
   (loadWorkstreamSnapshot, resolveWorkstreamSet, agentStatusHistogram,
   summarizeOwnedTasks) + roiBucket, with classifyEventVerb properly
   homed in src/logs.ts. All ≥2 callers.

2. PILLAR: "hard cap 1500 LOC per file; refactor signal at 800".
   src/state.ts sketch budget:
     - WorkstreamSnapshot type:        ~25 LOC
     - loadWorkstreamSnapshot:         ~30 LOC (lift cli/state.ts L93-139 verbatim)
     - resolveWorkstreamSet:           ~30 LOC (lift L141-194 verbatim)
     - agentStatusHistogram:           ~10 LOC (just Map<status,number>; no colour)
     - summarizeOwnedTasks:            ~15 LOC
     - roiBucket:                      ~10 LOC
     - banner/imports:                 ~30 LOC
     TOTAL                          ≈ ~150 LOC.
   Half the refactor signal. We are not sharding state.ts into a sibling
   with the same problem — we are extracting a DATA seam from a RENDER
   module. The render module (src/cli/state.ts) shrinks from 907 → ~330
   LOC after HUD deletion (per audit_state_ts). Both files end up well
   under 800.

3. PILLAR: "layout: flat at the root; one level of subdirs allowed for
   cohesive clusters".
   src/state.ts sits at the root next to its peers (src/agents.ts,
   src/tasks.ts, src/tracks.ts, src/workstream.ts, src/workspace.ts).
   No subdir. A subdir cluster (src/state/loadSnapshot.ts +
   src/state/resolveSet.ts + …) would be premature for ~150 LOC of pure
   functions on six different domains — there is no internal cluster
   here, only re-exports of work the domain modules already do. If
   src/state.ts ever crosses the 800 LOC refactor signal, that's the
   moment to revisit; not now. (The TUI itself, by contrast, IS a
   cohesive cluster — components + hooks + key handlers + an ink entry
   point — and DOES deserve src/tui/. Out of scope for this task.)

──────────────────────────────────────────────────────────────────────
Per-export contract (signatures + sketch + callers + cost)
──────────────────────────────────────────────────────────────────────

4. WorkstreamSnapshot — the central data contract.

   ```ts
   import type { LiveAgentsView } from "./agents.js";
   import type { TaskRow }        from "./tasks.js";
   import type { Track }          from "./tracks.js";
   import type { LogRow }         from "./logs.js";
   import type { WorkspaceRow, WorkspaceOrphan } from "./workspace.js";

   export interface WorkstreamSnapshot {
     /** Workstream name. cli/state.ts L97 (PerWsData.workstreamName). */
     workstreamName: string;

     /** Reality-reconciled agent view: agents[], orphans[], report.
      *  ALWAYS produced under listLiveAgents mode='status-only' so the
      *  poll loop refreshes status + pane title but does NOT prune
      *  mid-spawn placeholders or reap unreachable agents.
      *  cli/state.ts L98 + L114-118 (the `view = await listLiveAgents`
      *  call); agents.ts L767-784 (LiveAgentsView), L784-793
      *  (listLiveAgents). The "status-only" contract is the receipts of
      *  bug_agent_spawn_workspace_fk_failure +
      *  bug_pane_title_glyph_stuck_at_needs_input — see cli/state.ts
      *  L33-46 banner. The TUI poll loop MUST preserve this. */
     view: LiveAgentsView;

     /** Parallel tracks (union-find with diamond merge).
      *  cli/state.ts L99 + L120 (tracks = getParallelTracks);
      *  tracks.ts L30-46 (Track), L48 (getParallelTracks). */
     tracks: Track[];

     /** READY tasks (per the SQL view; status=OPEN AND every blocker
      *  terminal), ROI-sorted descending.
      *  cli/state.ts L100 + L121 (`listReady(...).sort(byRoiDesc)`);
      *  tasks.ts L512 (listReady); cli.ts L322 (byRoiDesc — the ROI
      *  comparator that ALSO needs to move to src/tasks.ts as part of
      *  this extraction; see ODDITIES). */
     ready: TaskRow[];

     /** IN_PROGRESS tasks. cli/state.ts L101 + L122 (listInProgress);
      *  tasks.ts L561. Insertion order; not ROI-sorted (the natural
      *  fallback the TUI's Agents card joins on owner). */
     inProgress: TaskRow[];

     /** BLOCKED tasks (status=OPEN AND ≥1 non-terminal blocker).
      *  cli/state.ts L102 + L123 (listBlocked); tasks.ts L535. */
     blocked: TaskRow[];

     /** Recently CLOSED tasks (limit 5; insertion order via
      *  listRecentClosed). cli/state.ts L103 + L124 (listRecentClosed);
      *  tasks.ts L577. */
     recentClosed: TaskRow[];

     /** Workspaces, decorated with `commitsBehindMain` per
      *  bug_workspace_stale_parent_silent_drift.
      *  cli/state.ts L104 + L128 (`await
      *  decorateWithStaleness(listWorkspaces(...))`);
      *  workspace.ts L36-50 (WorkspaceRow.commitsBehindMain),
      *  L568 (decorateWithStaleness — the only async part of the
      *  load: backends inspect local refs, never fetch). */
     workspaces: WorkspaceRow[];

     /** On-disk dirs under <state-dir>/workspaces/<ws>/ that have no
      *  vcs_workspaces row — the orphan-block-spawn footgun
      *  (bug_workspace_orphan_not_in_state).
      *  cli/state.ts L105 + L129 (listWorkspaceOrphans);
      *  workspace.ts L231-240, L271. */
     workspaceOrphans: WorkspaceOrphan[];

     /** Recent agent_logs entries with kind='event' (cap defaults
      *  documented per call-site; see loadWorkstreamSnapshot below).
      *  cli/state.ts L106 + L130 (`listLogs({kind:'event', limit})`);
      *  logs.ts L19-33 (LogRow), L131 (listLogs). */
     recent: LogRow[];
   }
   ```

   No new types. Every field is a re-use of an existing SDK type.
   Every field has a citation the implementer can grep for.

5. loadWorkstreamSnapshot

   ```ts
   export interface LoadWorkstreamSnapshotOptions {
     /** Cap on the recent events tail. Defaults to 20 (the static
      *  `mu state` value); the TUI Activity-log card passes its own
      *  card-fit cap. cli/state.ts L266 (eventLimit default).        */
     eventLimit?: number;
   }

   export async function loadWorkstreamSnapshot(
     db: Db,
     workstream: string,
     opts?: LoadWorkstreamSnapshotOptions,
   ): Promise<WorkstreamSnapshot>;
   ```

   - Sketch: VERBATIM lift of cli/state.ts L114-138, with
     `eventLimit = opts?.eventLimit ?? 20`. Order of SDK calls (matters
     because listLiveAgents flips status before listInProgress reads it):
       1. listLiveAgents(db, { workstream, mode: "status-only" })
       2. getParallelTracks(db, workstream)
       3. listReady(db, workstream).sort(byRoiDesc)
       4. listInProgress(db, workstream)
       5. listBlocked(db, workstream)
       6. listRecentClosed(db, workstream)
       7. await decorateWithStaleness(listWorkspaces(db, workstream))
       8. listWorkspaceOrphans(db, workstream)
       9. listLogs(db, { workstream, kind: "event", limit: eventLimit })
   - Error path: passthroughs. listLiveAgents may surface a
     ReconcileError; callers (cmdState today; ink poll hook tomorrow)
     handle. resolveWorkstream chain has already validated the name
     before this is called, so no NotFound here.
   - Callers (3): renderFullCard (cli/state.ts L304),
     renderMissionCard (cli/state.ts L408), and the ink TUI's
     useSnapshot hook (per design_module_layout). >=2 ✓.
   - Cost: dominated by SQLite reads (sub-ms each on the workstream-
     scoped indices), plus ONE async hop per workspace for
     decorateWithStaleness (jj/sl/git invocation per workspace; cached
     by the local refs cache, no fetch). For a typical wave (≤10
     agents, ≤5 workspaces, ≤30 tasks): 5–20 ms wall-clock. The poll
     loop's 1 s default tick has plenty of headroom; the +/- floor of
     100 ms is also safe. If staleness ever becomes the bottleneck, an
     `includeStaleness?: boolean` opt is the obvious carve-out (the
     TUI could refresh staleness on a separate slower tick).

6. resolveWorkstreamSet

   ```ts
   export interface WorkstreamSetOptions {
     /** Variadic -w. parseCsvFlag-canonicalised before this is called
      *  — caller hands flat string[]. */
     workstream?: string[];
     /** --all. Mutually exclusive with workstream[]. */
     all?: boolean;
   }

   export async function resolveWorkstreamSet(
     db: Db,
     opts: WorkstreamSetOptions,
   ): Promise<string[]>;
   ```

   - Sketch: VERBATIM lift of cli/state.ts L150-194. Branches:
       - both --all and -w  →  throw UsageError("mutually exclusive")
       - --all              →  listWorkstreams(db).map(w => w.name)
       - -w with entries    →  dedup; for each, tryResolveWorkstreamId
                               (throw WorkstreamNotFoundError on miss);
                               return.
       - none               →  resolveOptionalWorkstream() →
                               [single] or [] (auto-resolve from
                               $MU_SESSION / current tmux session).
   - Error path: UsageError (exit 2) for mutual exclusion;
     WorkstreamNotFoundError (exit 4) for typo; otherwise [] (caller
     decides whether emptiness is a usage error — cmdState renders
     "(no workstreams)"; the TUI launcher's policy is per
     design_module_layout but plausibly: prefer empty-state card over
     hard error).
   - Callers (2): cmdState (cli/state.ts L252) and the ink TUI
     launcher. >=2 ✓.
   - Cost: sub-ms per workstream lookup; --all hits one
     listWorkstreams call which is itself O(workstreams + sessions).
     Negligible at any realistic scale.

7. agentStatusHistogram  (PROMOTE iff static `mu state` adopts; otherwise drop)

   ```ts
   import type { AgentRow, AgentStatus } from "./agents.js";
   /** Map<status, count> over a slice of agents. Pure: no colour, no
    *  rendering. Two callers: ink Agents card header; static `mu
    *  state` Agents header (proposed adoption — see DECISION). */
   export function agentStatusHistogram(
     agents: readonly AgentRow[],
   ): ReadonlyMap<AgentStatus, number>;
   ```

   - Sketch: Map.set/get loop (lift cli/state.ts L735-741, MINUS the
     pc.* colour formatting and the `parts.join(" ")` string render).
     The colour render belongs in the consumer (ink card / static
     header); the SDK helper is the histogram only.
   - Callers (2 if adopted in static; 1 otherwise): ink Agents card;
     static cli/state.ts L320 (today: bold("Agents (N active, M
     orphan)") — proposed: also append the histogram).
   - Cost: O(agents). Sub-µs.

8. summarizeOwnedTasks  (PROMOTE iff static `mu state` adopts; otherwise drop)

   ```ts
   import type { TaskRow } from "./tasks.js";
   export interface OwnedTasksSummary {
     /** Display token: "—" (none) | "<task_id>" (one) | "⊕<N>" (many).
      *  Lifts the per-agent task-cell logic from cli/state.ts L558-560
      *  out of the HUD render. Pure (no colour). */
     bit: string;
     /** Underlying count for callers that want their own format. */
     count: number;
     /** The single owned task's local id, when count===1. */
     onlyTaskId?: string;
   }

   export function summarizeOwnedTasks(
     owned: readonly TaskRow[],
   ): OwnedTasksSummary;
   ```

   - Sketch: count = owned.length; bit = "—" | owned[0]?.name ?? "—" |
     `⊕${count}`; onlyTaskId = count === 1 ? owned[0]?.name : undefined.
     The CALLER does listTasksByOwner (it knows which agents to query
     and in what scope) and feeds the rows in. We do NOT make this take
     `(db, agent)` — callers already have the rows from
     loadWorkstreamSnapshot.inProgress (filterable by ownerName) so a
     second DB query per agent is unnecessary.
   - Callers (2 if static adopts): ink Agents card row;
     static cli/state.ts could fold this into the Agents-section
     "name (token)" — proposal flagged in audit ("In progress"
     coverage gap).
   - Cost: O(1) on the input rows.

9. roiBucket  (KEEP)

   ```ts
   /** ROI tiers used to colour task rows. Pure: returns the bucket
    *  name; the consumer maps bucket → picocolors function (or ink
    *  text colour). Lifts the threshold magic numbers (≥100 high,
    *  ≥50 mid) from cli/state.ts L626-628 (formatHudTasksTable).    */
   export type RoiBucket = "high" | "mid" | "low" | "infinite";
   export function roiBucket(impact: number, effortDays: number): RoiBucket;
   ```

   - Sketch:
       const r = effortDays > 0 ? impact / effortDays : Infinity;
       if (!Number.isFinite(r)) return "infinite";  // matches "∞" today
       if (r >= 100) return "high";
       if (r >= 50)  return "mid";
       return "low";
   - Callers (2): ink Ready card row; ink Tracks card cell. Same buckets
     are also applicable to a future `mu task list --colour` and to the
     static fallback's Ready section, but those don't ship at this
     seam-extraction so I'm not invoking adoption there. The two ink
     consumers alone clear ≥2.
   - Cost: O(1).

10. classifyEventVerb  (MOVE TO src/logs.ts, NOT src/state.ts)

    ```ts
    // in src/logs.ts (next to EVENT_VERB_PREFIXES)
    export interface ClassifiedEvent {
      verb: string;  // one of EVENT_VERB_PREFIXES
      rest: string;  // payload.slice(verb.length); preserves leading separator
    }
    /** Match `payload` against EVENT_VERB_PREFIXES. Returns {verb, rest}
     *  on match; null otherwise. The verb-boundary check is `next is
     *  space, tab, or end-of-string` (mirrors cli/state.ts L679-682)
     *  so we don't false-match `task addnote`. */
    export function classifyEventVerb(
      payload: string,
    ): ClassifiedEvent | null;
    ```

    - Sketch: VERBATIM lift of cli/state.ts L677-686 colorEventPayload,
      MINUS the `pc.cyan` call. The cyan colour goes in the (one)
      colour consumer — today colorEventPayload's REGRESSION TEST in
      test/state-render.test.ts L395-444 just asserts that every prefix
      gets the cyan; that test rewrites trivially against
      `classifyEventVerb` returning non-null. The ink Activity-log card
      calls classifyEventVerb and applies its own ink colour.
    - Callers (1 today, 2 if static adopts): ink Activity-log card.
      cli/format.ts printLogRow (used by both `mu log` and the static
      `Recent events` section of `mu state`) does NOT colour-by-verb
      today — only displayEventPayload-strips. STATIC ADOPTION is
      OPTIONAL: printLogRow could call classifyEventVerb to colour the
      verb cyan, gaining HUD parity for free. Recommend yes.
      Either way, classifyEventVerb belongs in src/logs.ts (next to
      EVENT_VERB_PREFIXES) — that is where the maintenance contract
      already lives (src/logs.ts L320-345), and the SDK importer
      (src/index.ts) re-exports cleanly.

──────────────────────────────────────────────────────────────────────

DECISION:

Pillar checks first:
  - "no anticipatory abstractions": all FIVE proposed exports of
    src/state.ts have ≥2 real callers (loadWorkstreamSnapshot 3,
    resolveWorkstreamSet 2, agentStatusHistogram 2 IFF static adopts,
    summarizeOwnedTasks 2 IFF static adopts, roiBucket 2). Recommend
    static adoption of agentStatusHistogram + summarizeOwnedTasks at
    this same extraction so the smell never appears in the audit log.
    classifyEventVerb is moved to src/logs.ts (next to its
    documented single-source-of-truth EVENT_VERB_PREFIXES); not in
    src/state.ts at all.
  - "1500 LOC cap; refactor signal at 800": src/state.ts ≈ 150 LOC.
    Half the refactor signal. cli/state.ts shrinks 907 → ~330 LOC
    after HUD deletion (per audit_state_ts). Both comfortable.
  - "flat at root; one subdir level for cohesive clusters":
    src/state.ts at the root, NOT src/state/. ~150 LOC of cross-domain
    re-uses isn't a cluster. Subdir reconsidered if/when the file
    crosses 800.

The seam contract:

  src/state.ts EXPORTS:
    - WorkstreamSnapshot      (interface; field-by-field above)
    - LoadWorkstreamSnapshotOptions  ({ eventLimit? })
    - WorkstreamSetOptions    ({ workstream?, all? })
    - loadWorkstreamSnapshot(db, ws, opts?)         → Promise<WorkstreamSnapshot>
    - resolveWorkstreamSet(db, opts)                → Promise<string[]>
    - agentStatusHistogram(agents)                  → ReadonlyMap<AgentStatus, number>
    - summarizeOwnedTasks(owned)                    → OwnedTasksSummary
    - OwnedTasksSummary       (interface)
    - roiBucket(impact, effortDays)                 → RoiBucket
    - RoiBucket               (type alias)

  src/logs.ts EXPORTS (new, but logically a sibling of the existing
  EVENT_VERB_PREFIXES + displayEventPayload + parseClaimEventActor
  cluster — same parser family):
    - classifyEventVerb(payload)                    → ClassifiedEvent | null
    - ClassifiedEvent         (interface)

  src/tasks.ts ALSO GAINS (move from cli.ts; pre-existing wart):
    - byRoiDesc       (already at cli.ts L322-324)
    - withRoiAll      (already at cli.ts L394-396)
    cli.ts re-exports both for back-compat (cli/* importers
    don't churn). roiBucket lives in src/state.ts not src/tasks.ts
    because the threshold magic numbers (100, 50, ∞) are a UI render
    decision, not a task-domain truth.

  src/index.ts (SDK barrel) gains:
    - loadWorkstreamSnapshot, resolveWorkstreamSet,
      agentStatusHistogram, summarizeOwnedTasks, roiBucket
    - WorkstreamSnapshot, LoadWorkstreamSnapshotOptions,
      WorkstreamSetOptions, OwnedTasksSummary, RoiBucket
    - classifyEventVerb, ClassifiedEvent

  src/cli/state.ts AFTER REFACTOR:
    - imports loadWorkstreamSnapshot + resolveWorkstreamSet (both
      replace its private helpers verbatim)
    - imports classifyEventVerb (in printLogRow path, IF static
      adopts the verb-cyan colourisation — recommended)
    - keeps fullJsonShape / missionJsonShape / cmdState dispatch /
      renderFullCard / renderMissionCard / renderMissionNoWorkstream /
      wireStateCommands (minus --hud + --lines)
    - DELETES every Hud* helper, hudPaneSize, agentStatusHistogram,
      colorEventPayload, MU_HUD_FORCE_SIZE branch, currentPaneSize
      import, Tagged<T>/wsCell, renderHudMode
    - target post-shrink size: ~330 LOC

The ink TUI module (src/tui/, per design_module_layout) consumes
EXACTLY the src/state.ts seam. Zero data-load logic on the ink side;
zero rendering logic in src/state.ts. Hard split.

NEXT (for the implementer; tasks already on the DAG):
  - design_module_layout: confirm src/tui/ subdir cluster, the post-
    shrink shape of src/cli/state.ts, and where the ink hook
    (useSnapshot) and entry point (mu_isTty → ink, else cmdState) live.
  - design_card_iface: the still-open question from audit_state_ts —
    is "Workspaces" a v0 5th card or a v0.1 promotion? The seam above
    already SUPPLIES workspaces + workspaceOrphans on every snapshot,
    so the answer is purely a card-iface decision (cost-free on the
    SDK side).
  - design_card_{agents,tracks,ready,log}: each card consumes the SDK
    seam (its own slice of WorkstreamSnapshot) plus, where applicable,
    the helpers (agentStatusHistogram, summarizeOwnedTasks, roiBucket,
    classifyEventVerb).
  - When implementation starts: adopt agentStatusHistogram +
    summarizeOwnedTasks in renderFullCard / renderMissionCard at the
    same time as the extraction so the ≥2-callers pillar test holds
    on day one (otherwise the new exports are flagged anticipatory by
    the next audit).

VERIFIED:
  - Read every line cited above (cli/state.ts L1-200, L538-741;
    agents.ts L82-111 + L736-793; tasks.ts L83-96 + L673-712;
    tracks.ts L1-80; workspace.ts L36-50 + L231-271; logs.ts L19-77 +
    L240-345; cli/format.ts L275-292; cli.ts L315-396;
    index.ts head).
  - Confirmed the PerWsData ⇄ WorkstreamSnapshot field set is
    one-to-one; no new fields, no dropped fields. The JSON contract
    (fullJsonShape / missionJsonShape) keeps working unchanged on top
    of the new type.
  - Confirmed ONLY src/cli.ts imports cli/state today (grep
    `from.*cli/state` → src/cli.ts L37 only). The ink TUI will
    import from src/state.ts (and src/index.ts re-exports) — never
    from cli/state.ts. No new lateral coupling.
  - Confirmed colorEventPayload is exported solely for the
    test/state-render.test.ts regression suite (L395-444) — the
    rewrite path is "test imports classifyEventVerb instead, asserts
    non-null for every EVENT_VERB_PREFIXES entry". Same coverage.
  - Confirmed listLiveAgents `mode: "status-only"` is the contract
    the poll loop must pass; loadWorkstreamSnapshot bakes it in so
    there is no way for a TUI implementer to accidentally pass
    `"full"` and trigger the bug_agent_spawn_workspace_fk_failure /
    bug_pane_title_glyph_stuck_at_needs_input regressions. (No opt
    on the function exposes the mode; non-poll callers shouldn't be
    calling loadWorkstreamSnapshot at all.)
  - LOC budget for src/state.ts (~150) confirmed by summing the
    eight code blocks above.

ODDITIES (carry to the implementer):

  1. byRoiDesc + withRoiAll (cli.ts L322, L394) belong in src/tasks.ts,
     not src/cli.ts. Pre-existing wart from before tasks.ts existed as
     a hub. Move during this seam-extraction so loadWorkstreamSnapshot
     can `import { byRoiDesc } from "./tasks.js"` without an awkward
     SDK→cli import. cli.ts re-exports both for cli/* back-compat.

  2. The audit's `summarizeOwnedTasks` originally took `(db, agent)`
     and ran listTasksByOwner internally. Reconsidered: the snapshot
     ALREADY contains inProgress (filterable by ownerName), so making
     the helper take `(rows)` saves one DB query per agent per tick.
     Caller pattern: `summarizeOwnedTasks(snapshot.inProgress.filter(
     t => t.ownerName === agent.name))`. The HUD's existing per-agent
     listTasksByOwner call (cli/state.ts L557) is therefore an N-query
     pattern we get to delete in passing.

  3. agentStatusHistogram returns Map<AgentStatus, number> (not the
     pre-rendered colour string the HUD spits out). The render is a
     consumer concern; the SDK helper is a histogram. The HUD's
     STATUS_COLORS lives in src/agents.ts L390 (STATUS_EMOJI is the
     emoji-only map; the colour mapping belongs to whichever
     consumer needs it). No SDK colour leak.

  4. eventLimit defaults: today static = 20, HUD = 10 (cli/state.ts
     L266). The TUI Activity-log card will pass its own card-fit
     value. Default to 20 (the static value); document at the
     LoadWorkstreamSnapshotOptions site.

  5. loadWorkstreamSnapshot is the ONLY async on the snapshot path
     (decorateWithStaleness + listLiveAgents). The other 7 calls are
     synchronous `db.prepare(...).all(...)`. The TUI hook can
     therefore use a single `await loadWorkstreamSnapshot(...)` per
     tick; no need for fan-out concurrency.

  6. colorEventPayload was previously exported from cli/state.ts
     for the regression test alone (L677). After the move, the test
     should import classifyEventVerb from src/logs.ts — and the
     export of colorEventPayload disappears from cli/state.ts
     entirely. No external callers (grep clean).

  7. resolveWorkstreamSet currently returns `string[]` (workstream
     names). The TUI launcher will likely want the FIRST element only
     (TUI runs per-workstream; the multi-ws stacking surface is
     static-only). That's a caller policy, not a seam change — the
     helper still returns the canonical set.

  8. The audit's "Workspaces card v0.1 vs v0" question is OUT OF
     SCOPE for this seam: workspaces + workspaceOrphans are on the
     snapshot regardless. design_card_iface decides whether to
     render them.

  9. currentPaneSize import (cli/state.ts L80) and MU_HUD_FORCE_SIZE
     env (L494) become dead with HUD deletion. Verified
     currentPaneSize has no other importers under src/  (grep:
     only cli/state.ts L80). It can be removed from src/tmux.ts as
     part of the same wave — flag for the implementer; not part of
     the SDK seam itself.
````

### #2 by "scout-2", 2026-05-11T11:01:57.636Z

```
CLOSE: seam contract drafted; signatures + caller list + pillar checks in note
```
