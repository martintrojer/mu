---
id: "selfdoc_design"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 80
effort_days: 0.3
roi: 266.67
owner: null
created_at: "2026-05-08T06:19:50.895Z"
updated_at: "2026-05-08 06:21:50"
blocked_by: []
blocks: ["selfdoc_infra"]
---

# Design: self-documenting verb output (next-step hints + structured JSON)

## Notes (1)

### #1 by null, 2026-05-08T06:21:50.619Z

```
AUDIT: making mu commands self-documenting + SKILL.md cleanup.

Surfaced from session feedback: SKILL.md is 771 lines and growing; per-verb hints duplicate what could live in verb output. Idea: move per-verb instructions/hints OUT of SKILL into the output of the verb itself (mu CLI is mainly for agents — verbose output is fine). --json gets structured nextSteps.

PRINCIPLE
  Every successful output answers: what changed, what next?
  Every error answers: why, what are the actionable resolutions?
  Verbose lines are pc.dim (humans skim, agents read; tools ignore).
  --json stays machine-shaped; structured `nextSteps` mirrors the human hints.

CURRENT STATE OF OUTPUTS (audit)

Already self-documenting (model templates, keep as-is):
  - mu workstream init: created + attach hint + spawn hint
  - mu workstream destroy dry-run: counts + (dry-run; rerun with --yes)
  - ClaimerNotRegisteredError: 3 actionable next steps with concrete commands (gold standard)
  - mu task claim --self: informative output (--self by X; OPEN -> IN_PROGRESS; owner=NULL)
  - mu adopt: idempotent vs new + retitle hint
  - mu doctor: structured table per category

Partially self-documenting (small wins):
  - mu agent spawn: add "Send work: mu agent send X ...", "Read pane: mu agent read X"
  - mu agent close: workspace-kept hint exists conditionally; verify always emitted
  - mu task add: add "Show: mu task show ID", "Block: mu task block ID --by ...", "Note: mu task note ID ..."
  - mu task claim (worker): add "Drop notes as you work: mu task note ...", "Close with grounding: mu task close ID --evidence ..."
  - mu task close: add "Reopen: mu task open ID"
  - mu task release: add "Reclaim: mu task claim ID"
  - mu workstream init: add "Plan tasks:", "See state: mu state -w X"
  - mu adopt: add "Send work:", "Visible in: mu agent list -w W"
  - mu agent list (empty): "Spawn: ...", "Adopt: ..."
  - mu task list (empty): "Add: mu task add -w ..."
  - mu task next (empty): explain why (all blocked / closed / owned); suggest mu task blocked

Bare success messages (need upgrade):
  - mu task block / unblock: show resulting graph snippet; suggest mu task tree Y
  - mu task delete: dangerous; add "no undo; restore from ~/.local/state/mu/mu.db.bak"
  - mu workspace create: print path + cd $(mu workspace path X)
  - mu approve add: print slug + mu approve wait <slug>
  - mu agent send: mention mu agent read X -n 50 + mu log --tail
  - mu sql DELETE/UPDATE: emit an event log entry recording the statement

Errors needing actionable hints:
  - TaskNotFoundError: suggest mu task list -w W; mu task search <pattern>
  - TaskAlreadyOwnedError: suggest mu task release; mu task owned-by <current>
  - AgentNotFoundError: suggest mu agent list -w W and mu agent list -w *
  - AgentNotInWorkstreamError: already shaped; check message
  - WorkstreamNameInvalidError: already actionable
  - CycleError: print the attempted path (A -> ... -> B -> A)
  - CrossWorkstreamEdgeError: suggest moving the task or duplicating
  - WorkspaceExistsError: suggest mu workspace path <agent>
  - PaneNotFoundError: suggest tmux list-panes -a
  - AgentDiedOnSpawnError: already rich

JSON output gaps:
  - Every verb that grew a hint gets nextSteps as a string array
  - Bare error JSON: error class + message + nextSteps when --json was on the request
  - nextSteps for errors is structured: list of (intent, command) pairs (LLMs can eval/exec command directly)

WHAT LEAVES SKILL (becomes verb output / --help)
  - Per-verb annotation comments in CLI verb list (~140 LOC)
  - "Evidence on lifecycle verbs" subsection (~12 LOC; --help + claim/close output covers it)
  - "Picking the spawned executable" (~25 LOC; mu agent spawn --help)
  - "The reaper" (~10 LOC; reaper-emitted note + log already explains)
  - Many Common patterns examples (~80 LOC; surface as next-step hints in relevant verbs)

WHAT STAYS IN SKILL (LLM-only context, irreducible)
  - Vocabulary, When-to-reach-for-mu, Mental model
  - Orchestrator loop (the canonical 6-step discipline)
  - DOs / DON'Ts / What mu is NOT
  - CLI verb list ONE-LINER per verb (discoverability)
  - Canonical multi-verb patterns (parallel work, quote-rich prompts, subscribe-don't-poll, irreversible-needs-approval)

Estimated SKILL after cleanup: 771 -> ~450-500 LOC (~35% reduction).

IMPLEMENTATION PLAN (split into 4 tasks, ordered by dependencies)

selfdoc_infra (~150 LOC):
  - printNextSteps(steps) helper in cli.ts (pc.dim, "Next:" prefix)
  - nextSteps field on every verb-result JSON shape that grows them
  - Error handler: when --json was on, emit (error, message, nextSteps) JSON to stderr instead of red text
  - Wire 5-7 representative verbs (claim, add, spawn, adopt, init, close, release)
  - Tests: next-step rendering + JSON shape

selfdoc_errors (~100 LOC):
  - Each typed error gains nextSteps() static / getter
  - Handler concatenates them after message; includes in JSON
  - Tests: each error class

selfdoc_verbs_round2 (~200 LOC):
  - Wire hints + nextSteps for the rest of the verbs
  - Round-trip: every verb success path emits nextSteps (or explicitly opts out)

selfdoc_skill_cleanup (~300 LOC removed):
  - Strip per-verb commentary now in verb output
  - Replace verb table with one-liner-per-verb + "run mu <verb> --help"
  - Move scattered tips into the patterns section as named entries
  - Update USAGE_GUIDE to reference verb output
  - Keep DOs/DON'Ts/mental model

Total: ~750 LOC across 4 commits, mostly subtractive once infra lands.

NON-GOALS (rejected)
  - --quiet flag: workers have --json; humans get TUI. Third surface.
  - Contextual hints (DB-aware): "if task has no notes, suggest note" requires per-output queries. Static hints first; dynamic only if proven needed.
  - Removing anything from --help. Those stay canonical reference.

DOGFOOD AS PROOF (each item below has hit me >=2 times this session)
  - had to teach an agent to read SKILL for "mu task claim" syntax instead of just using --help
  - the orchestrator pattern (--self) only revealed itself after I stumbled into ClaimerNotRegisteredError; if claim output had hinted "after claim, run X" patterns earlier, the workflow break would have surfaced sooner
  - mu task add NEVER says "now show it / now block on / now note it" — every new user has to learn this from SKILL
  - bare "Closed X" doesn't tell me reopen exists
  - mu agent spawn output stops at "Spawned X" — agents have to know send/read/close exist from SKILL

ACCEPTANCE CRITERIA (for selfdoc_dogfood at the end)
  - SKILL.md <= 550 LOC (from 771)
  - All success-path verb outputs include nextSteps OR explicit comment opting-out (e.g. mu sql, mu state)
  - All typed errors include nextSteps in both human and JSON output
  - Existing tests still pass; new tests cover nextSteps rendering per verb
  - Live walkthrough: spin up a fresh workstream, do plan/spawn/claim/note/close cycle relying ONLY on verb output (no SKILL) — confirm a fresh agent could complete it.
```
