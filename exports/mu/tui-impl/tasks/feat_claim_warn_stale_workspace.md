---
id: "feat_claim_warn_stale_workspace"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: "worker-3"
created_at: "2026-05-12T13:05:10.796Z"
updated_at: "2026-05-12T15:21:34.918Z"
blocked_by: ["feat_mu_bare_launches_tui"]
blocks: []
---

# FEAT: 'mu task claim --for <agent>' warns (or refuses with --strict) when the assignee's workspace is ≥WARN_BEHIND_THRESHOLD commits behind main — reuse the TUI's existing isStale() primitive; same threshold (10)

## Notes (2)

### #1 by "π - mu", 2026-05-12T13:05:15.460Z

```
MOTIVATION (verbatim user)
--------------------------
\"warn when assigning a task to an agent whose workspace is 'very' old. there is some threshold in the tui for this.\"

CURRENT STATE
-------------
- src/cli/tui/cards/workspaces.tsx:124 already has isStale(behind) — true when ≥10.
- The Workspaces card colours behind counts: green ≤2, yellow 3-9, red ≥10.
- That threshold (10) is the natural 'very old' definition; reuse it.
- 'mu task claim --for <agent>' (src/cli/tasks/claim.ts) is the dispatch verb. Today it succeeds without checking the assignee's workspace state — orchestrators discover the staleness later when cherry-picks pull in unrelated re-reverts.
- A sibling problem also exists: 'mu agent send <agent> ...' may dispatch follow-on work to a stale workspace too. Both surfaces should warn.

DESIGN
------
1. PROMOTE isStale → src/state.ts (or a small src/staleness.ts) so it isn't TUI-coupled. Keep the TUI re-exporting for back-compat.
2. NEW SDK function in src/workspace.ts:
     export interface WorkspaceStaleness {
       agentName: string;
       workstreamName: string;
       commitsBehindMain: number | null;
       isStale: boolean;
     }
     export function getWorkspaceStaleness(db: Db, agentName: string, workstreamName: string): WorkspaceStaleness | null;
   Returns null when no workspace exists.

3. mu task claim --for <agent>:
   - Resolve target agent (handles cross-ws via --for ws/agent).
   - Look up workspace; if isStale → emit a stderr warning (NOT an error) before the claim succeeds.
   - Add --strict-staleness flag: if stale, REFUSE the claim with a typed error (TaskClaimStaleWorkspaceError, exit code mapped via handle()).
   - JSON output: include 'staleness' field per the new shape.
   - nextSteps: when warned, append a hint 'Refresh first: mu workspace refresh <agent> -w <ws>'.

4. mu agent send <agent>:
   - Same shape: warn (not error) when the agent's workspace is stale.
   - --strict-staleness opt-in for the same refusal path.
   - Skip when agent has no workspace (read-only roles).

5. WARN_BEHIND_THRESHOLD = 10 (matches isStale today). Consider exposing as a constant in src/staleness.ts.

TESTS
-----
- src/state.ts / staleness.ts: unit test isStale.
- src/workspace.ts: integration test getWorkspaceStaleness with seeded behind counts.
- test/cli-task-claim.test.ts: extend with stale-workspace fixture; assert warning on stderr + claim still succeeds; assert --strict-staleness errors out.
- test/cli-agent-send.test.ts: same.

UI PARITY
---------
The TUI's Workspaces card highlight colours (already there) stay. The new STDERR warning matches the visual language: 'WARN: worker-1 workspace is 14 commits behind main (≥10 = stale)'. nextSteps surface 'mu workspace refresh worker-1' so the operator can fix in one keystroke.

DOCS
----
- docs/USAGE_GUIDE.md mu task claim section: document the new warning + --strict-staleness flag.
- docs/USAGE_GUIDE.md mu agent send section: same.
- skills/mu/SKILL.md 'Hard-earned dispatch lessons': add a bullet 'mu warns at claim/send time if the assignee's workspace is stale — refresh first'.
- CHANGELOG.md (under v0.5.0 features): bullet under 'Quality of life'.

CONSTRAINTS
-----------
- Conventional commit prefix: cli: (touches CLI dispatch)
- Four greens before commit.
- Suggested commit:
    cli: 'mu task claim --for' + 'mu agent send' warn when assignee workspace is ≥10 commits behind main (--strict-staleness opt-in to refuse outright)

OUT OF SCOPE
------------
- Don't auto-refresh on stale (orchestrator-by-design intent — refresh kills no LLM context BUT is still operator-driven).
- Don't expose the threshold via env / config (anti-feature). Hard-coded constant; bump in code if needed.
- Don't ALSO warn on 'workspace dirty' — different sibling concern (covered by feedback fb_close_require_clean).

⚠️ ORDERING ⚠️
This task is a v0.5 feature. Gate behind:
  - feat_mu_bare_launches_tui (the v0.5 entry-point shift)

Or treat it as standalone v0.4.1 polish — orchestrator's call.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_claim_warn_stale_workspace -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-12T15:21:34.918Z

```
CLOSE: 1da1c5b: claim/send warn on stale agent workspaces and --strict-staleness refuses
```
