---
id: "nit_orchestrator_dispatched_without_task"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: null
created_at: "2026-05-08T11:37:51.227Z"
updated_at: "2026-05-09T05:26:18.446Z"
blocked_by: []
blocks: []
---

# ORCHESTRATOR-DISCIPLINE: dispatched code-reviewer-1 / test-reviewer-1 via bare mu agent send instead of via a claimable task — no mu task wait possible

## Notes (2)

### #1 by π - mu, 2026-05-08T11:37:51.365Z

```
SURFACED LIVE during the code-reviewer / test-reviewer dispatch.

WHAT HAPPENED
1. Spawned code-reviewer-1 + test-reviewer-1 with read-only role.
2. Sent the review prompts via `mu agent send <name> "...big prompt..."`.
3. Wanted to wait for them. Tried `for sleep 60; status=...` — that's polling agent status, fragile.
4. The right primitive is `mu task wait <id>` but the agents had no task to claim/close.

ROOT CAUSE
SKILL.md "Orchestrator loop" step 4 says "Claim before sending instructions". I skipped step 4 — the reviewers worked from the inline prompt without a task as a contract. Without a task, there's nothing to wait on, no audit trail, no completion signal.

FIX (no code change; orchestrator-discipline)
The right shape was:

  # Per agent:
  mu task add review_code_pass_1 -w roadmap-v0-2 --title "Code review pass" --impact 50 --effort-days 0.5
  mu task claim review_code_pass_1 -w roadmap-v0-2 --for code-reviewer-1 --evidence "..."
  mu agent send code-reviewer-1 "Read mu task show review_code_pass_1 ..."

  # Then:
  mu task wait review_code_pass_1 review_test_pass_1 --timeout 1800

The agent closes its task when done with `mu task close review_code_pass_1 --evidence "filed N findings"`. The wait exits 0 → orchestrator triages.

POSSIBLE FOLLOW-UP (no urgency)
- Maybe `mu agent send --task <id>` is a useful sugar that auto-claims + sends + reminds the agent to close-when-done. Not now; only if this discipline gap surfaces ≥2 more times.

VERIFIED
- mu task wait exists (commit d6b5d0d), polls every 1s, has --timeout / --any / --status.
- agent status alone is too noisy as a completion signal (worker idles between tool calls; status flips back to needs_input).
```

### #2 by π - mu, 2026-05-09T05:26:18.334Z

```
FILES: skills/mu/SKILL.md (Orchestrator loop step 3 + DOs).
COMMANDS: npm run typecheck/lint/test/build (all green: 713/713).
DECISION: Hardened the existing step 3 ("Claim before sending") with an explicit "even for one-shot reviewers / scouts" carve-out + the rationale (no mu task wait, no audit, status-flips-back-to-needs_input is too noisy as a completion signal). Also strengthened step 4 to remind the agent to mu task close on done. Added a corresponding DOs bullet so the rule has two surfaces (loop + checklist).
NEXT: nit_orchestrator_send_new_for_unrelated_work shipped in the same SKILL.md pass.
VERIFIED: typecheck + lint + 713 tests + build all green; SKILL.md still under any sensible doc cap.
ODDITIES: deliberately did NOT add a typed verb (`mu agent send --task <id>` sugar) per the note: "only if this discipline gap surfaces ≥2 more times". Doc fix first, code fix only on second hit.
```
