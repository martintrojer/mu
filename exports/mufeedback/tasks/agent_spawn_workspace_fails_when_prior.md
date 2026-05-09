---
id: "agent_spawn_workspace_fails_when_prior"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 1
roi: 60.00
owner: null
created_at: "2026-05-08T08:21:46.467Z"
updated_at: "2026-05-08T09:16:38.696Z"
blocked_by: []
blocks: []
---

# agent spawn --workspace fails when prior workspace dir exists

## Notes (1)

### #1 by system, 2026-05-08T08:21:59.575Z

```
REPRO:
1. mu agent spawn worker-1 -w foo --workspace --command "pi-meta ..."
   -> creates ~/.local/state/mu/workspaces/foo/worker-1
2. mu agent close worker-1 -w foo
   -> agent gone but SKILL.md says "workspace untouched" (intentional;
      preserves uncommitted artifacts)
3. mu agent spawn worker-1 -w foo --workspace --command "pi-meta ..."
   -> error: vcs git: workspacePath already exists:
      /Users/mtrojer/.local/state/mu/workspaces/foo/worker-1

EXPECTED (one of):
- mu agent spawn --workspace re-uses an existing workspace dir for the
  same (workstream, agent) combo when one is present, OR
- the error message points at `mu workspace free <agent>` as the
  recovery path (currently it does not), OR
- there's an explicit --workspace=reuse / --workspace=fresh option that
  matches the documented "workspace not auto-cleaned" semantics.

WHY THIS HURTS:
The SKILL.md "workspaces are NOT freed when you close an agent"
behavior is correct (artifacts survive crashes), but the natural
recovery flow ("just respawn the worker on the same name to retry")
crashes with a low-context error. The Next: hint on the error doesn't
mention `mu workspace free` either.

CONTEXT: hit during modelbridge-parity orchestration when the first
spawn used bare `pi` and needed to be retried with `pi-meta`.

PROPOSED:
- At minimum: improve the error to suggest
  `mu workspace free <agent> -w <workstream>` and/or
  `mu agent spawn ... --no-workspace` (reuse existing)
- Better: spawn flag --workspace=reuse|fresh|require-empty (default
  reuse, matching close-doesn't-free semantics).

WORKAROUND I USED:
mu workspace free worker-1 -w foo && mu agent spawn worker-1 -w foo --workspace ...
```
