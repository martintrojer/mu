---
id: "review_test_output_padding_implementation_test"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-08T11:25:22.715Z"
updated_at: "2026-05-08T12:57:12.764Z"
blocked_by: []
blocks: []
---

# REVIEW: printNextSteps padding test asserts on implementation, not behaviour

## Notes (1)

### #1 by "test-reviewer-1", 2026-05-08T11:25:40.576Z

```
FILES: test/output.test.ts:38-58 ; src/output.ts:43-49 (printNextSteps).
WHAT THE TEST CLAIMS: it("pads intent labels so colons align across steps")
WHAT IT ACTUALLY VERIFIES: After stripping ANSI escape sequences, asserts that the position of `:` in the short-label line equals the position of `:` in the long-label line. The test re-implements the alignment formula (find colon position, compare).
GAP: This is the prototypical "test recreates implementation" smell flagged by the skill. A regression that switches from space padding to tab padding (`label.padEnd(width, "	")`) — visually broken, indents at non-monospaced widths — would still produce equal colon positions in the string-as-codepoints sense and pass the test. A regression that double-pads (`labelWidth * 2`) would also pass since both lines would still align with each other. The test cares about RELATIVE alignment but says nothing about absolute correctness, padding semantics, or that humans can actually see aligned colons in a terminal.
WHY IT MATTERS: Low-stakes, but emblematic. The test costs ~12 LOC including a custom ANSI-strip regex; its signal is "two strings have a `:` at the same index" which is much weaker than the test name suggests. A simpler rewrite would match a snapshot of the rendered output (sans ANSI), giving stronger signal at less code. Also: the file's header `// mu's interpreted state on the pane border` is wrong (copy-pasted from agents.test.ts? — actually no, this is output.test.ts; the header is fine). False alarm — the file header is fine.
SUGGESTED FIX: Replace with a direct snapshot:
  const out = capture(() => printNextSteps([{intent:"Short",command:"a"},{intent:"Much longer label",command:"b"}]));
  expect(stripAnsi(out)).toMatchInlineSnapshot(`
    "Next:
      Short             : a
      Much longer label : b
    "
  `);
Behavioural, more readable, catches every padding regression. Or keep an alignment assertion but ALSO assert the absolute padding (`expect(stripAnsi(shortLine)).toMatch(/^  Short {13} : a$/)`).
```
