---
id: "archive_phase3_destroy_integration"
workstream: "roadmap-v0-3"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-09T17:14:41.739Z"
updated_at: "2026-05-10T06:07:34.703Z"
blocked_by: ["archive_phase2_cli_verbs"]
blocks: []
---

# Phase 3: mu workstream destroy --archive <label> shorthand

## Notes (1)

### #1 by π - mu, 2026-05-09T17:17:31.151Z

```
Phase 3 — mu workstream destroy --archive <label>.

DEPENDS ON: Phase 2 (archive_phase2_cli_verbs).

Tiny: ~30 LOC. The semantic is "snapshot first → archive → destroy". If the archive step fails, abort the destroy (no silent data loss).

═══ CHANGES ═══

src/cli/workstream.ts (destroy verb):
  + new --archive <label> flag
  + before the existing destroyWorkstream call, if --archive is set:
      const archiveResult = addToArchive(db, opts.archive, opts.workstream);
      // continue to destroyWorkstream; both events emitted independently
  + Errors:
      ArchiveNotFoundError → exit 3 (refuse to destroy; archive must exist)
      WorkstreamNotFoundError → already handled by destroyWorkstream

The flag is purely additive sugar — equivalent to:
  mu archive add <label> -w <ws>
  mu workstream destroy -w <ws> --yes

But atomically wrapped so the operator can't forget either half.

═══ TESTS (extend test/workstream-destroy or workstream-cli.test.ts) ═══

  1. destroy --archive <existing-label> --yes: workstream gone, archive grew.
  2. destroy --archive <nonexistent> --yes: errors with ArchiveNotFoundError, workstream UNTOUCHED.
  3. destroy --archive <label> WITHOUT --yes: dry-run mode prints "would archive N tasks to <label>" alongside the existing dry-run output.

═══ DOCS ═══

  docs/USAGE_GUIDE.md: extend the Workstreams section's destroy bullet with the --archive flag.
  skills/mu/SKILL.md: update the destroy line.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close archive_phase3_destroy_integration -w roadmap-v0-3 --evidence '...'
```
