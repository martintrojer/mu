---
id: "skill_nudge_prompt_agents_with_relative"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 1
roi: 30.00
owner: null
created_at: "2026-05-08T08:25:45.853Z"
updated_at: "2026-05-08T09:39:54.907Z"
blocked_by: []
blocks: []
---

# skill nudge: prompt agents with relative paths only when in workspaces

## Notes (1)

### #1 by null, 2026-05-08T08:25:45.962Z

```
OBSERVATION:
When orchestrating workers in --workspace dirs, including absolute
paths (e.g. ~/hacking/modelbridge/packages/...) in the prompt
defeats workspace isolation. Pi happily edits the absolute path,
which lands in the MAIN repo, not the worker's isolated workspace.

The mu SKILL.md "Default workspace rule" section already warns about
trampling, but doesn't explicitly cover this prompt-shape gotcha. A
single-line addition would help:

  > When prompting a workspace agent, refer to files by repo-relative
  > paths only (`packages/core/...`, not `~/hacking/repo/packages/...`).
  > Absolute paths bypass the workspace and land in whatever cwd the
  > absolute path happens to point at.

CONTEXT: hit during modelbridge-parity wave 1; worker-1 wrote
discoveryHelpers.ts changes into ~/hacking/modelbridge instead of
~/.local/state/mu/workspaces/modelbridge-parity/worker-1. Recovered
via git stash; work was correct, just in the wrong tree.

PROPOSED:
Append the rule to mu SKILL.md "Default workspace rule" or to the
"Quote command-rich prompts" subsection.
```
