---
id: "review_code_unescape_note_text_placeholder_brittle"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-09T08:36:49.352Z"
updated_at: "2026-05-09T09:03:03.087Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: unescapeNoteText uses an in-band sentinel that legitimate note content could collide with

## Notes (1)

### #1 by code-reviewer-1, 2026-05-09T08:37:06.619Z

```
FILES: src/cli/tasks.ts:84-101 (unescapeNoteText)

FINDINGS: unescapeNoteText uses a literal Unicode placeholder string to "protect" backslashes during the two-pass shell-escape translation:

  const PLACEHOLDER = "\u{1F511}backslash\u{1F511}";
  return s
    .split("\\")
    .join(PLACEHOLDER)
    .replace(/\n/g, "
")
    .replace(/\t/g, "	")
    .replace(/\r/g, "")
    .split(PLACEHOLDER)
    .join("\");

If a legitimate note happens to contain the literal string "\" (the codepoint U+1F511 KEY emoji surrounding the word "backslash"), the placeholder collision corrupts the note. Probability of collision is astronomically low for a real user typing notes, but:

1. The smell is the in-band sentinel pattern itself. The skill calls out "Clever code that hurts readability" — the two-pass split/join with a magic string is harder to read than a single-pass regex with a capture group or an explicit state machine.

2. The codepoint choice (🔑 U+1F511) is also a length-2 string under JavaScript's UTF-16 representation, so the .split() is on a 2-element pattern, not 1. Defensible but obscure.

A cleaner shape:

  return s.replace(/\(\|n|t|r)/g, (_, ch) => {
    switch (ch) {
      case "\": return "\";
      case "n":  return "
";
      case "t":  return "	";
      case "r":  return "";
      default:   return _;
    }
  });

Single pass, no sentinel, no edge case. Works because the regex captures the escape character that follows the backslash, so we make the precedence decision per-match rather than via two-pass priming.

WHY IT MATTERS: 25. Code-smell + sub-1% chance of real-user corruption. Not a security issue (this is per-user note content; collision would only corrupt the user's own notes).

SUGGESTED FIX (~10 LOC):
Replace the two-pass with the single-regex shape above. Add a unit test for the cases:
  - "\\n" (backslash + n) → "\n" (literal backslash-n, NOT newline)
  - "\n" (slash-n) → "
" (newline)
  - "\\\n" (backslash + slash-n) → "\
" (literal backslash + newline)
  - \-containing input passes through verbatim.

ALTERNATIVES CONSIDERED:
- A proper hand-rolled state machine. More LOC; same correctness; loss of regex compactness.
- Cryptographic placeholder (random UUID per call). Solves collision; extra LOC; still in-band.

EVIDENCE: src/cli/tasks.ts:88-101.
```
