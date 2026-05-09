---
id: "review_code_free_agent_no_nextsteps"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-08T11:35:07.314Z"
updated_at: "2026-05-08T11:46:39.354Z"
blocked_by: []
blocks: []
---

# REVIEW: cmdFree skips nextSteps despite '--json everywhere' contract

## Notes (2)

### #1 by code-reviewer-1, 2026-05-08T11:35:07.426Z

```
FILES:
  src/cli.ts:1128-1146 (cmdFree)

FINDINGS: cmdFree is the only write verb that does NOT emit nextSteps in either its JSON or human output. Compare with cmdSpawn / cmdSend / cmdClose / cmdTaskClose etc. which all build a `next: NextStep[]` and pass it via printNextSteps + into the JSON envelope.

  async function cmdFree(db, name, opts) {
    ...
    if (opts.json) {
      emitJson({ agent: name, ...r });   // no nextSteps key
      return;
    }
    if (!r.changed) { console.log(...); return; }   // no printNextSteps
    console.log(`Freed ${name} (${prev} → ${status})`);   // no printNextSteps
  }

WHY IT MATTERS: small consistency hole in the self-documenting-output contract (commits 6115800 / db34616 / 852574b explicitly promised "nextSteps hints across all write verbs"). The agent has no follow-on prompt after `mu agent free worker-1` — natural next is "send something else? close? wait?". And the JSON output shape diverges from peers, breaking the user assumption that every write verb's --json envelope carries `nextSteps`.

SUGGESTED FIX (~10 LOC):

  const next: NextStep[] = [
    { intent: "Send work to the freed agent", command: `mu agent send ${name} "..." -w ${ws}` },
    { intent: "Close the agent", command: `mu agent close ${name} -w ${ws}` },
    { intent: "Watch live events", command: `mu log -w ${ws} --tail` },
  ];
  if (opts.json) { emitJson({ agent: name, ...r, nextSteps: next }); return; }
  ...
  printNextSteps(next);

ALTERNATIVES CONSIDERED:
  - "free is too low-volume to bother": the contract is universal; opt-out invites future drift.

EVIDENCE: grep -n "nextSteps" src/cli.ts | wc -l shows nextSteps is wired in every cmdX EXCEPT cmdFree. The 6115800 commit message explicitly says "every CLI verb"; cmdFree was missed (probably because freeAgent was added in be15fdf BEFORE the universalisation pass and never revisited).
```

### #2 by code-reviewer-1, 2026-05-08T11:35:27.876Z

```
ADDENDUM (broader scope): cmdApprovalGrant (cli.ts:2778) and cmdApprovalDeny (cli.ts:2793) ALSO emit no nextSteps and have the same JSON-shape divergence (`emitJson(row)` instead of `emitJson({ ...row, nextSteps })`). Same root cause: the approve verbs landed before the universalisation pass.

Good follow-on nextSteps for approve grant/deny:
  grant → "List remaining pending" → mu approve list --status pending -w <ws>
       → "See workstream state"     → mu state -w <ws>
  deny  → "List remaining pending" → mu approve list --status pending -w <ws>
       → "Re-add the approval"      → mu approve add -r '...' -w <ws>

Total fix scope across cmdFree + cmdApprovalGrant + cmdApprovalDeny: ~25 LOC. Keep this finding's effort estimate at 0.05; add a separate CHANGELOG bullet "fix: --json envelope and nextSteps now consistent across `agent free` / `approve grant` / `approve deny`".
```
