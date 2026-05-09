---
id: "nit_orchestrator_send_new_for_unrelated_work"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: null
created_at: "2026-05-08T13:27:05.948Z"
updated_at: "2026-05-09T05:26:29.318Z"
blocked_by: []
blocks: []
---

# ORCHESTRATOR-DISCIPLINE: when sending unrelated work to an existing agent, consider sending '/new' first to clear context

## Notes (2)

### #1 by π - mu, 2026-05-08T13:27:06.077Z

```
SURFACED LIVE during the multi-agent dogfood waves.

OBSERVATION
When the orchestrator dispatches a follow-on task to an already-spawned agent (worker-1 just closed taskA, now claimed taskB), the new prompt is appended to whatever context the agent had from taskA — file reads, search results, partial scratch work. For RELATED tasks (snap_design → snap_schema → snap_undo_verb), this is a feature: the agent already has the right files paged in.

For UNRELATED tasks (workspace-bug fix → log-format polish → unrelated CLI verb), the stale context is at best noise and at worst misleads the agent into "continuing" the previous thread mentally.

PROPOSED DISCIPLINE
Before sending the next prompt, send '/new' (pi's "start fresh" verb; equivalent CLIs have similar — claude-code's `/new`, codex's `/clear`) to wipe the in-memory context. The pane scrollback is preserved (so the operator can still scroll back); only the LLM's working set is reset.

  mu agent send worker-1 '/new'
  mu agent send worker-1 '$(cat <<EOF_PROMPT
  ... new task prompt ...
  EOF_PROMPT
  )'

WHY THIS ISN'T AUTOMATIC IN mu
- mu is CLI-runtime-agnostic; it doesn't know whether the inner CLI has a /new equivalent.
- Even when it does (pi/pi-meta), the operator may WANT context preserved (related work).
- Adding a `--reset-context` flag to `mu agent send` would couple mu to the inner CLI's semantics — wrong layer.

WHAT mu COULD DO (small, opt-in)
- Document the pattern in skills/mu/SKILL.md "Sending follow-on work" section.
- Maybe a `mu agent send --new <name> "..."` sugar that sends `/new` then sleeps 500ms then sends the prompt. Sugar only; pi-specific so behind a `--cli pi` check OR documented as "CLI-specific glyph".
- Maybe `mu agent reset <name>` as a typed verb that just sends `/new` (or whatever the CLI's reset verb is, looked up by `--cli`). One-liner per agent CLI.

PROMOTION CRITERION
Mention in SKILL.md is the smallest. Promote to a typed verb if "did the orchestrator forget /new again?" comes up ≥2 more times.
```

### #2 by π - mu, 2026-05-09T05:26:29.208Z

```
FILES: skills/mu/SKILL.md (new "Sending follow-on work to an existing agent" subsection between "After spawning, observe" and "Tear down a workstream"; new DOs bullet).
COMMANDS: npm run typecheck/lint/test/build (all green: 713/713).
DECISION: Documented the discipline only — no typed verb. Per the original note: mu is CLI-runtime-agnostic, even when the inner CLI has /new the operator may want context preserved, and adding a `--reset-context` flag would couple mu to the inner CLIs semantics (wrong layer). Promotion criterion preserved: typed verb only if the gap surfaces ≥2 more times. Also added the explicit `sleep 1` between the `/new` and the prompt — without it the prompt arrives before pi has swallowed the slash command and ends up appended to the last reply.
NEXT: nothing; promotion criterion not yet met.
VERIFIED: typecheck + lint + 713 tests + build all green.
ODDITIES: chose NOT to put the section under "If you ARE the agent" — this is an ORCHESTRATOR concern (operator deciding whether the next dispatch deserves a context wipe). The orchestrator-loop section (around line 113) gets the cross-reference via the new DOs bullet.
```
