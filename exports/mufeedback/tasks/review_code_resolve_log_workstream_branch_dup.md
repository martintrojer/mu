---
id: "review_code_resolve_log_workstream_branch_dup"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: "worker-mf-2"
created_at: "2026-05-09T08:31:24.278Z"
updated_at: "2026-05-09T09:02:25.587Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: cli/log.ts resolveLogContext duplicates workstream-resolution chain

## Notes (1)

### #1 by code-reviewer-1, 2026-05-09T08:31:39.036Z

```
FILES: src/cli/log.ts:65-83 (resolveLogContext)

FINDINGS: resolveLogContext has a load-bearing logic asymmetry between two of its three branches:

  if (opts.as) {
    const workstream = opts.workstream ? opts.workstream : await resolveOptionalWorkstream();
    return { source: opts.as, workstream };
  }
  const paneId = process.env.TMUX_PANE;
  if (paneId) {
    const agent = getAgentByPane(db, paneId);
    if (agent) {
      return { source: agent.name, workstream: opts.workstream ?? agent.workstream };
    }
  }
  const workstream = opts.workstream ?? (await resolveOptionalWorkstream());
  return { source: "user", workstream };

In the --as branch, when opts.workstream is undefined we call resolveOptionalWorkstream().
In the pane branch, when opts.workstream is undefined we use agent.workstream (skipping resolveOptionalWorkstream).
In the fallback branch, when opts.workstream is undefined we call resolveOptionalWorkstream().

That's intentional for the pane branch (the agent's workstream is more authoritative than the env). But the asymmetry is subtle and the function returns `workstream: string | null` from one path and `workstream: string` from another (the pane path can never return null when we get there with an agent). The type is `string | null` either way, but the invariants are non-obvious.

Smaller smell: `opts.workstream ? opts.workstream : ...` in the --as branch is exactly what `opts.workstream ?? ...` would say more cleanly (and the fallback branch already uses `??`).

WHY IT MATTERS: 30. Pure nit. The inconsistency between `?` and `??` in adjacent ternaries is exactly the readability friction the skill flags as "non-idiomatic". The asymmetry in workstream resolution is correct but uncommented.

SUGGESTED FIX (~5 LOC):
1. Replace `opts.workstream ? opts.workstream : await resolveOptionalWorkstream()` with `opts.workstream ?? (await resolveOptionalWorkstream())` for consistency with line 80.
2. Add a one-line comment to the pane branch explaining why agent.workstream wins over resolveOptionalWorkstream() (so the next reader doesn't "fix" it to be symmetric).

EVIDENCE: src/cli/log.ts:67 uses `?`, src/cli/log.ts:80 uses `??`. Identical semantic operation; only one form.
```
