---
id: "review_data_import_drops_system_author"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.25
roi: 200.00
owner: "worker-2"
created_at: "2026-05-13T12:41:54.354Z"
updated_at: "2026-05-13T13:20:44.284Z"
blocked_by: []
blocks: []
---

# REVIEW med: import/export collapses system note author

## Notes (3)

### #1 by "worker-2", 2026-05-13T12:41:54.759Z

```
FILE(S):
  src/exporting.ts:188-191
  src/importing.ts:331-336
  test/importing.integration.test.ts:67-101

FINDING (non-idiomatic):
  // exporter
  lines.push(`### #${i + 1} by ${note.author ?? "system"}, ${note.createdAt}`);

  // importer
  const authorRaw = headerRest.slice(0, lastComma);
  const author = authorRaw === "system" ? null : authorRaw;
  const createdAtNote = headerRest.slice(lastComma + 2);

WHY IT'S A PROBLEM:
  The export format collapses a null note author and the literal author string "system" into the same markdown header. On import, every `by system` note is restored as `author = NULL`, so a real note authored by the actor label "system" loses metadata. This violates the import/export round-trip contract in the file header, which says every note survives, and it is easy to miss because existing tests only assert the authors for design notes, not the `ship` note that is seeded with author "system".

PROPOSED FIX:
  Encode null authors distinctly in markdown frontmatter or note headers (for example `by <none>` / `by null` / a small per-note metadata line) and treat the literal `system` as an ordinary string. Keep backward compatibility by accepting old `by system` buckets as null only when no explicit author sentinel exists. Update importer/exporter together and add a regression asserting a note with `author: "system"` round-trips as "system" while a null author round-trips as null.

EFFORT NOTE:
  Medium-small because the on-disk bucket format is user-visible. Choose a backward-compatible parse rule and update README/manifest examples only if the rendered format changes visibly.
```

### #2 by "worker-2", 2026-05-13T13:20:43.459Z

```
FILES: src/exporting.ts; src/importing.ts; test/importing.integration.test.ts; test/workstream.integration.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (0); npm run lint (0); npx vitest run test/importing.integration.test.ts test/workstream.integration.test.ts (0); npm run test:fast (0); npm run test (0; 2339 passed); npm run build (0); node dist/cli.js --help (0); git commit (d95babd)
FINDINGS: live DB schema stores task_notes.author as nullable free text; schema comments explicitly include "system" as a legitimate free-text author label, not a NULL sentinel. Export previously rendered NULL as by system and import coerced by system back to NULL, which collapsed a literal "system" author.
DECISION: keep literal "system" as a real string and encode NULL authors explicitly as by null in bucket markdown, with real author strings quoted via yamlScalar/unquote for a lossless database-boundary round-trip.
VERIFIED: full data SDK gate clean; round-trip test now asserts author "system" survives and NULL stays NULL.
NEXT: none.
```

### #3 by "worker-2", 2026-05-13T13:20:44.284Z

```
CLOSE: d95babd: round-trip preserves 'system' author; src/exporting.ts encodes NULL as null and src/importing.ts stops coercing system to NULL
```
