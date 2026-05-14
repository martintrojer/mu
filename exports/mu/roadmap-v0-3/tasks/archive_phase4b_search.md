---
id: "archive_phase4b_search"
workstream: "roadmap-v0-3"
status: CLOSED
impact: 40
effort_days: 0.3
roi: 133.33
owner: null
created_at: "2026-05-09T17:14:41.932Z"
updated_at: "2026-05-10T06:09:51.247Z"
blocked_by: ["archive_phase2_cli_verbs"]
blocks: []
---

# Phase 4b: mu archive search <pattern> (LIKE over titles+notes)

## Notes (1)

### #1 by "π - mu", 2026-05-09T17:17:31.422Z

```
Phase 4b — mu archive search <pattern> [--label <l>].

DEPENDS ON: Phase 2.

Smallest of the bunch (~80 LOC). LIKE search over archived_tasks.title and archived_notes.content.

═══ CLI ═══

  mu archive search <pattern> [--label <l>] [--limit N] [--json]

If --label omitted: search across every archive.
Default --limit 50.

═══ SDK ═══

  export interface ArchiveSearchHit {
    archiveLabel: string;
    sourceWorkstream: string;
    originalLocalId: string;
    title: string;
    matchKind: 'title' | 'note';
    matchSnippet: string;            // ~120 chars around the match
  }

  export function searchArchives(db, opts: { pattern, label?, limit }): ArchiveSearchHit[]

═══ TESTS ═══

  1. Search title-only match.
  2. Search note-content match.
  3. --label scopes correctly.
  4. --limit truncates.
  5. SQL-injection-safe (the pattern is a parameter, never concatenated).

═══ DOCS ═══

USAGE_GUIDE.md: archive search example.
CHANGELOG.md: one line.
skills/mu/SKILL.md: add to verb list.

⚠️ git commit -am '...' THEN mu task close archive_phase4b_search -w roadmap-v0-3 --evidence '...'
```
