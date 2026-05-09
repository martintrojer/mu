---
id: "review_code_print_next_steps_duplicated"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-08T11:30:14.435Z"
updated_at: "2026-05-08T11:46:39.456Z"
blocked_by: []
blocks: []
---

# REVIEW: printNextSteps duplicated inline in emitError instead of called

## Notes (1)

### #1 by code-reviewer-1, 2026-05-08T11:30:14.546Z

```
FILES:
  src/output.ts:30-49 (printNextSteps)
  src/cli.ts:264-272 (emitError's hand-rolled stderr copy)

FINDINGS: src/output.ts exports printNextSteps which formats nextSteps as dim text with padded labels and writes to stdout. emitError in cli.ts re-implements the SAME formatting (Math.max width, padEnd loop, "Next:" header) but writes to stderr. The two blocks differ only in console.log vs console.error.

  // output.ts
  const labelWidth = Math.max(...steps.map((s) => s.intent.length));
  console.log(pc.dim("Next:"));
  for (const step of steps) {
    const label = step.intent.padEnd(labelWidth);
    console.log(pc.dim(`  ${label} : ${step.command}`));
  }

  // cli.ts (in emitError)
  console.error(pc.dim("Next:"));
  const labelWidth = Math.max(...steps.map((s) => s.intent.length));
  for (const s of steps) {
    console.error(pc.dim(`  ${s.intent.padEnd(labelWidth)} : ${s.command}`));
  }

WHY IT MATTERS: low-stakes nit but two copies of a 5-line formatter is the canonical "future divergence" smell — when one is updated (e.g. with a new section heading or wider padding), the other won't be.

SUGGESTED FIX (~5 LOC): give printNextSteps an output sink:

  export function printNextSteps(steps, sink: (s: string) => void = console.log): void { ... }

Then emitError can call `printNextSteps(steps, (s) => console.error(s))`. Or simpler: extract `formatNextStepsBlock(steps): string[]` and let each caller pick their stream.

ALTERNATIVES CONSIDERED:
  - "leave it, it's 5 lines": the 5-line formatter is a single grep away from a third copy when someone adds nextSteps to a third surface (mu hud? mu state human-mode?).

EVIDENCE: byte-level diff between the two blocks shows only the console.log/console.error swap.
```
