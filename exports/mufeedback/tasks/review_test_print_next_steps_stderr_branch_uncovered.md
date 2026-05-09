---
id: "review_test_print_next_steps_stderr_branch_uncovered"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: "worker-mf-4"
created_at: "2026-05-09T08:30:58.964Z"
updated_at: "2026-05-09T09:21:58.451Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: printNextStepsTo('stderr') branch has no test coverage

## Notes (1)

### #1 by test-reviewer-1, 2026-05-09T08:31:22.208Z

```
FILES: test/output.test.ts:104-150 (printNextSteps describe block); src/output.ts:91-108 (printNextSteps + printNextStepsTo).

WHAT THE TESTS CLAIM: Tests for "printNextSteps" cover the rendering of nextSteps, including the empty-array no-op, the header line, padding semantics, and (implicitly via review_code_print_next_steps_duplicated, which extracted printNextStepsTo) the single source of truth for the formatting.

WHAT THEY ACTUALLY VERIFY: Only the stdout sink (printNextSteps wrapper). Every it() spies `console.log` and asserts on the captured `logs[]`. The stderr branch — printNextStepsTo(steps, "stderr") — is only used by emitError() in src/cli.ts:235 on the error path. There is no spy on console.error, no test that the stderr sink writes to stderr instead of stdout, and no test that the stderr branch even renders the same "Next:" + padded-label format.

GAP: A regression that flipped the sink switch (e.g. someone "simplifies" `sink === "stderr" ? console.error : console.log` to `console.log` and runs the suite) would pass every test in this file. The bug manifests in production as: scripts that redirect stdout away from stderr (`mu task add ... 2>err.json >ignored.txt`) suddenly stop seeing the typed-error nextSteps in err.json — the entire premise of the success-vs-error stream split (the rationale captured in printNextStepsTo's comment) silently regresses. Worth noting: emitError's test in test/error-nextsteps.test.ts also doesn't capture the stderr sink (it spies on `console.error` for the JSON envelope only, not for the dim Next: lines).

WHY IT MATTERS: This is exactly the false-confidence pattern: a deliberate refactor (review_code_print_next_steps_duplicated) added a sink parameter to make stderr-vs-stdout routing the single source of truth, and the test suite for the refactor's own helper doesn't pin the sink behaviour. Severity: 70 (the sink is the whole point of the refactor; a one-line silent regression is low-friction).

SUGGESTED FIX: Add one test in the existing describe("printNextSteps") block (~10 LOC):
  it("printNextStepsTo('stderr') routes to console.error, NOT console.log", () => {
    const errs: string[] = []; const logs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((m: string) => errs.push(m));
    const logSpy = vi.spyOn(console, "log").mockImplementation((m: string) => logs.push(m));
    try {
      printNextStepsTo([{ intent: "X", command: "y" }], "stderr");
      expect(errs.length).toBe(2); // header + 1 step
      expect(logs).toEqual([]);
      expect(errs[0]).toContain("Next:");
    } finally { errSpy.mockRestore(); logSpy.mockRestore(); }
  });
Estimated +1 it block, +13 LOC.

EVIDENCE: src/output.ts:100 — `const out = sink === "stderr" ? console.error : console.log;` is the entire sink-discrimination logic; nothing exercises the true branch. Counterexample: change `console.error` to `console.log` in src/output.ts and run `vitest run test/output.test.ts` — every test passes. The only consumer is emitError in src/cli.ts:235 (steps emitted on error path); test/error-nextsteps.test.ts asserts only on the JSON envelope and on err.message text, not on console.error calls for the dim block.
```
