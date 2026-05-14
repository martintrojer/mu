---
id: "nit_agent_exists_error_clarity"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 50
effort_days: 0.1
roi: 500.00
owner: null
created_at: "2026-05-08T07:26:49.291Z"
updated_at: "2026-05-08T07:33:28.469Z"
blocked_by: []
blocks: []
---

# NIT: AgentExistsError message + hints don't make global-uniqueness obvious; jq hint is wrong

## Notes (2)

### #1 by null, 2026-05-08T07:26:49.411Z

```
Surfaced when user asked "what if agents have the same name across workstreams?".

Current behaviour (correct, safe):
  agents.name is the global PRIMARY KEY. mu agent spawn rejects collisions across workstreams via AgentExistsError. The schema does the right thing.

The friction is in the error message + nextSteps:

1. Message: "agent already exists: <name>"
   No mention that "agent names are globally unique across workstreams". An orchestrator seeing this for the first time has to guess whether "exists" means "in this workstream" or "anywhere". Add the clarification:
     "agent already exists: <name> (agent names are globally unique across workstreams)"

2. nextSteps[0] uses a broken jq:
     mu agent list -w * --json | jq '.[] | select(.agents[].name == "<name>")'
   But `mu agent list -w *` treats `*` as a literal workstream name, returning {"workstream":"*","agents":[],"orphans":[]} with exit 0. The jq filter then sees an object (not an array) and produces no output. Replace with a correct lookup that actually finds the existing agent:
     mu sql "SELECT name, workstream FROM agents WHERE name='<name>'"

Sub-bug discovered while writing this:
  mu agent list does NOT have an "across all workstreams" mode. -w <name> is a scope filter; -w '*' is treated as a literal name. The verb's --help should say so, OR mu agent list could grow a real --all flag (cf. mu workspace list --all, which works). 
  
  Filed implicitly here; if it bites again, consider a separate bug task.

Implementation (~10 LOC):
  - src/agents.ts AgentExistsError: append the global-uniqueness phrase to the super() message.
  - src/agents.ts AgentExistsError.errorNextSteps(): replace the jq hint with the SQL lookup.
  - Optional: also fix the underlying mu agent list quirk (-w '*' silent no-match -> error or treat as --all). Defer unless dogfood proves friction.
  - Test: update the snapshot/assertion in test/error-nextsteps.test.ts for the new shape.
```

### #2 by null, 2026-05-08T07:33:25.687Z

```
FILES: src/agents.ts (test/error-nextsteps.test.ts unchanged — existing assertions check shape only, not text)
DIFFSTAT: src/agents.ts | 6 ++++--, 1 file changed, 4 insertions(+), 2 deletions(-)
VERIFIED: gate green (typecheck, lint, 563 tests pass, build clean)
```
