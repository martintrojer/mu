---
id: "nit_task_note_shell_metachar_hint"
workstream: "mufeedback"
status: CLOSED
impact: 15
effort_days: 0.2
roi: 75.00
owner: null
created_at: "2026-05-08T09:53:56.795Z"
updated_at: "2026-05-08T10:14:50.921Z"
blocked_by: []
blocks: []
---

# NIT: task note hints should warn about shell metacharacters

## Notes (2)

### #1 by π - infer-rs, 2026-05-08T09:53:56.898Z

```
FILES: mu CLI hint/output behavior.
COMMANDS: mu task note code_prune_branch_metadata -w infer-rs "...  ..." from a shell.
FINDINGS: Backticks in a double-quoted mu task note were executed by the parent shell before mu saw the note, producing 'command not found: prune' and deleting the inline code snippets from the note. The mu skill documents quote/heredoc discipline, but mu's Next hints still show double-quoted task-note examples.
DECISION: Track as UX nit, not a data bug.
NEXT: Consider making task-note hints use single quotes/heredoc examples or adding a warning when note text is supplied directly from a shell.
VERIFIED: Infer-rs note #254 lost inline snippets; note #255 corrected using a quoted heredoc.
ODDITIES: This is fundamentally shell behavior, but mu can steer users away from it in hints.
```

### #2 by π - infer-rs, 2026-05-08T09:54:12.557Z

```
CORRECTION: The first note on this task also demonstrated the same problem by losing the literal example containing backticks.

COMMANDS: `mu task note code_prune_branch_metadata -w infer-rs "... \`prune e\` ..."` from a shell.
FINDINGS: Double-quoted shell arguments expand backticks before `mu` sees them. A safer hint would show single quotes or a quoted heredoc, for example `mu task note task_id "$(cat <<'EOF_NOTE' ... EOF_NOTE)"`.
VERIFIED: mufeedback note #256 lost the inline code snippet; this note was added with a quoted heredoc.
```
