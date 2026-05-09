---
id: "schema_v5_design_amendments"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: "worker-mf-3"
created_at: "2026-05-09T11:01:52.075Z"
updated_at: "2026-05-09T11:07:02.465Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone", "schema_v5_migration_script"]
---

# schema v5: amend design doc — pin migration table-ordering + clarify SDK-breaking-change story + add real-DB fixture test

## Notes (1)

### #1 by π - mu, 2026-05-09T11:02:44.125Z

```
ORCHESTRATOR REVIEW of docs/SCHEMA_v5_DESIGN.md (commit beb5546). Gaps to fix BEFORE schema_v5_migration_script lands.

═══ GAP 1: Migration table-ordering not pinned ═══

The design doc says "for each entity table in dependency order" but doesn't list the order. The order matters for the migration script — child tables MUST come after their parents because we need the parent's surrogate id map populated before we can rewrite the child's TEXT FK.

PIN THIS in the design doc, in this exact order:

  1. workstreams      (no parents)
  2. agents           (parent: workstreams)
  3. tasks            (parents: workstreams + agents [owner FK])
  4. task_edges       (parent: tasks)
  5. task_notes       (parent: tasks)
  6. agent_logs       (parent: workstreams)
  7. vcs_workspaces   (parents: agents + workstreams)
  8. approvals        (parent: workstreams)
  9. snapshots        (no FK; copy verbatim)
  10. schema_version  (single-row meta; bump to 5)

Rationale comment per ordering: agents-before-tasks because tasks.owner_id → agents.id; vcs_workspaces-after-agents for the same reason. agent_logs only depends on workstreams.

═══ GAP 2: SDK-breaking-change story is implicit ═══

The design says "CLI surface does NOT change" — true. But the SDK surface DOES change for every consumer (type signatures gain workstream context). The doc should explicitly call this out:

ADD a "SDK consumer impact" section:
  - Every public SDK function that takes an entity name (claimTask, addTask, getTask, etc.) gains `workstream: string` as the FIRST positional arg (or part of an opts bag).
  - This is BREAKING for any external SDK consumer. mu's own CLI is the only known consumer today, so practical impact is contained to schema_v5_cli_boundary updates.
  - --json shape preserved (CLI emits operator-facing names; surrogate ids stay internal). Documented in CHANGELOG under [Unreleased] / Breaking.
  - The "exposing internalId someday" mention should explicitly say NEVER without a real consumer asking — anti-feature pledge applies.

═══ GAP 3: Migration test plan needs the real-DB fixture case ═══

The 9-point test plan covers synthetic fixtures. ADD a 10th test:

  10. **Production-shape fixture migrates cleanly.** The mu repo's own ~/.local/state/mu/mu.db at the time of writing has 50+ closed tasks across 5 workstreams (mufeedback, roadmap-v0-2, infer-rs, dogfood-snap, ws). The migration script should handle it without crashing.
  
  Implementation: copy the operator's actual mu.db (or a sanitised export of it) into test/fixtures/v4-real.db, run the script, assert row counts pre/post match per table. CI-skip when the fixture is missing (some contributors won't have it). Document the fixture-generation command in the test file header so it's reproducible.

═══ GAP 4: Snapshot interaction wasn't covered ═══

The doc says snapshots survive workstream destroy intentionally. But: what about snapshots taken DURING the migration? Specifically:
  - The mu undo machinery captures a snapshot before destructive verbs.
  - The migration script is itself a destructive verb (in the operational sense) — it rewrites the DB.
  - Should the migration script ALSO capture a snapshot before running? The "rename mu.db → mu.db.v4-backup" approach IS a snapshot, of sorts, but it's not entered into the snapshots table.

DECIDE in the amendments:
  - Recommend: yes, write the v4-backup file path into snapshots table BEFORE renaming, with label="pre-v5-migration backup". Then `mu undo` lists it normally (though restore semantics for a v4 snapshot are complex — handle by `mu undo` refusing with a typed error pointing back at the migration script).
  - Or: explicitly document "v4-backup is the migration's escape hatch, not a tracked snapshot. Operator restores manually if the migration fails — `mv mu.db mu.db.v5-broken && mv mu.db.v4-backup-<ts> mu.db`."

PICK one path; document it.

═══ DELIVERABLE ═══

Edit docs/SCHEMA_v5_DESIGN.md:
  1. Append "Migration table ordering" subsection with the 10-step list.
  2. Append "SDK consumer impact" subsection with the breaking-change call-out.
  3. Add the 10th test (production-shape fixture).
  4. Add the snapshot-interaction subsection with the chosen path.

CHANGELOG entry under Changed: "schema v5 design doc amended (migration ordering, SDK impact, real-DB fixture, snapshot interaction)".

SCOPE: ~0.2 days. Pure doc.
GATE: typecheck + lint + test + build green (trivially).

⚠️ FINAL: \`git commit -am '...'\` THEN \`mu task close ...\`.
```
