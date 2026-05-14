---
id: "adopt_design"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: null
created_at: "2026-05-07T17:51:23.918Z"
updated_at: "2026-05-07T18:05:02.616Z"
blocked_by: []
blocks: ["adopt_impl"]
---

# Design: mu adopt CLI shape, SDK shape, error cases

## Notes (1)

### #1 by null, 2026-05-07T18:04:56.937Z

```
DESIGN: mu adopt — register an orphan tmux pane as a managed agent.

CLI shape:
  mu adopt <pane-id-or-title> [--name <agent>] [--cli <name>] [--role read-only|full-access] [-w <workstream>]

  Examples:
    mu adopt %15                              # adopt by pane id; agent name defaults to pane title
    mu adopt %15 --name worker-2              # adopt with explicit name (override pane title)
    mu adopt worker-2                         # adopt by pane title (looked up in current workstream)
    mu adopt %15 --cli claude --role read-only

SDK shape:
  adoptAgent(db, { paneId, name?, cli?, role?, workstream }): Promise<AdoptResult>
  AdoptResult = { agentName, paneId, paneTitleSetTo, alreadyAdopted: boolean, previousTitle: string | null }

Identity contract:
  - The pane's title MUST equal the agent's name post-adopt (claim protocol invariant).
  - If --name is given AND differs from pane title, mu retitles the pane via tmux select-pane -T <name>.
  - If --name is omitted, the pane title becomes the agent name verbatim. Validate via isValidAgentName.

Validation:
  - Pane must exist in tmux (check via listPanesInSession or capture-pane probe).
  - Pane must be in the named workstream's tmux session (mu-<workstream>); error AgentNotInWorkstreamError if cross-session.
  - Resolved name must pass isValidAgentName.
  - Resolved name must not collide with an existing agent in ANY workstream (agents.name is globally unique today; same constraint as spawn).
  - If pane already has a DB row with the same name and pane id, return alreadyAdopted=true (idempotent).

Errors (typed, mapped to exit codes via existing handler):
  - AgentExistsError         — name already taken (exit 4 conflict)
  - PaneNotFoundError (NEW)  — pane id doesn't exist in tmux (exit 5 substrate)
  - AgentNotInWorkstreamError — pane is in a different tmux session (exit 4)
  - WorkstreamNameInvalidError / agent name invalid (exit 2 usage)

Interaction with reconcile:
  - Adopt INSERTs the agents row directly (status='spawning' or 'needs_input'; reconcile will resolve on next list).
  - Subsequent mu agent list shows the pane under 'agents', not 'orphans'.
  - mu agent close worker-2 still works; will kill the pane (the adopted pane is now 'mu-managed'). User can opt out of the kill by not closing — but there's no '--detach' verb in 0.1.x, so adoption is a one-way commitment.

Out of scope for this design:
  - Bulk adopt (mu adopt --all). Earn if dogfood shows N>2 orphans being adopted in one go.
  - mu detach (the inverse of adopt — remove DB row but leave the pane). Earn if a real workflow needs it.
  - Adopting panes from OTHER workstreams (cross-workstream move). Reject for now.

Friction-driven decision: --name defaults to pane title rather than requiring it explicitly. The pane-title-as-identity convention means most orphans were spawned by a user who already gave them a name; mu just records that name. The override case (--name <new>) is for orphans that have a non-conventional title (e.g. raw 'pi' or 'bash' as the title) where the user wants to give them a proper agent name.

Test cases (drives the impl):
  1. Adopt by pane id, pane title is already a valid agent name -> agents row inserted, no retitle.
  2. Adopt by pane id, --name <X> differs from title -> retitle + insert.
  3. Adopt by pane id, pane doesn't exist -> PaneNotFoundError.
  4. Adopt where the resolved name collides with existing agent -> AgentExistsError.
  5. Adopt by pane id from a different tmux session -> rejected (cross-session).
  6. Adopt twice with same input -> alreadyAdopted=true (idempotent).
  7. Adopt with invalid pane id format ('foo') -> rejected at validation layer.
  8. Adopt --cli claude --role read-only sets those columns correctly.

Implementation path (informs adopt_impl):
  1. New function adoptAgent in src/agents.ts (~40 LOC).
  2. New PaneNotFoundError class in src/tmux.ts (3 LOC).
  3. CLI verb in src/cli.ts (~25 LOC).
  4. Tests (~120 LOC across unit + integration).
  5. SKILL.md verb-list update + USAGE_GUIDE entry.

Net estimate: ~200 LOC for the whole adopt track. Fits the 'small additions' scope per ROADMAP.
```
