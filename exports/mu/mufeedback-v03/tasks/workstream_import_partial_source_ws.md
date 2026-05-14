---
id: "workstream_import_partial_source_ws"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-10T07:43:35.991Z"
updated_at: "2026-05-10T07:57:25.865Z"
blocked_by: []
blocks: []
---

# feat: mu workstream import — accept a per-source-ws path or --source-ws <name> for partial bucket import

## Notes (1)

### #1 by "π - mu", 2026-05-10T07:44:18.602Z

```
mu workstream import — partial bucket import (one source-ws at a time).

═══ THE FRICTION (just hit during dogfood) ═══

Operator: 'is now possible to import a workstream from this bucket?' yes — but the only shape today is "import the whole bucket". Walking exports/mu/ ⇒ both mufeedback (105 tasks) AND roadmap-v0-2 (45 tasks) restored. To get just one, the workaround is:

  mu workstream import exports/mu                # both restored
  mu workstream destroy -w mufeedback --yes      # cleanup the unwanted one

Wasteful: 105 INSERTS + 105 DELETEs for nothing. Also error-prone (forget the cleanup ⇒ unwanted live ws).

The original import design (workstream_import_from_markdown task note) explicitly carved this out:
  > Partial import: --only <task-id-glob> to cherry-pick from a bucket. Defer until friction surfaces.

Friction surfaced. File now.

═══ THE TARGET SHAPE ═══

Two equivalent forms:

  Form 1 — pass the per-source-ws subdir directly:
    mu workstream import exports/mu/roadmap-v0-2

  Form 2 — pass the bucket + --source-ws filter:
    mu workstream import exports/mu --source-ws roadmap-v0-2
    mu workstream import exports/mu --source-ws mufeedback,roadmap-v0-2  # CSV variadic per cli_audit_plurality_uniformity

ATTEMPTED form 1 today; the parser refused with:
  error: not a valid mu bucket export at exports/mu/roadmap-v0-2: manifest.json missing

That's the right error today — per-source-ws subdirs have no top-level manifest.json. The fix is to teach importBucket to accept BOTH an actual bucket dir AND a per-source-ws subdir; auto-detect.

═══ DETECTION RULE ═══

Walk the dir:
  - If `<dir>/manifest.json` exists with `bucketVersion: 2`: BUCKET MODE (today's behavior, plus optional --source-ws filter).
  - Else if `<dir>/README.md` exists, `<dir>/INDEX.md` exists, AND `<dir>/tasks/` is a directory: SOURCE-WS MODE. Resolve the source-ws name via `<dir>`'s parent dir's manifest.json (look up `<basename>` in sources). If the parent has no bucketVersion-2 manifest OR the dir's basename isn't in sources: error 'this looks like a per-source-ws subdir but no parent bucket manifest validates it'.
  - Else: today's ImportBucketInvalidError.

Source-ws name comes from `<basename>` (e.g., 'roadmap-v0-2' from `exports/mu/roadmap-v0-2`); the parent manifest's `sources[<basename>]` entry exists ⇒ accept. The bucketLabel is read from the parent manifest.

═══ --source-ws FILTER ═══

When the operator passes a real bucket dir AND --source-ws X (or X,Y), import ONLY those subdirs. Errors:
  - --source-ws lists a name not in the bucket manifest: ImportSourceNotInBucketError (exit 4) listing the bad name + valid names.
  - Empty --source-ws (e.g. ',,'): UsageError.

--source-ws is variadic per the convention (cli_audit_plurality_uniformity): repeat OR comma-separate; or both. Use parseCsvFlag.

═══ INTERACTION WITH --workstream <name-override> ═══

Today's --workstream restricts to single-source buckets. After this change:
  - Form 1 (per-source-ws subdir): single source by construction; --workstream override allowed.
  - Form 2 (--source-ws X): single source after filter; --workstream override allowed.
  - Form 2 (--source-ws X,Y): multi-source after filter; --workstream override REJECTED (today's "single-source only" rule).
  - No --source-ws + multi-source bucket: --workstream rejected (today's rule).

Atomicity: each source-ws's import is its own transaction (today's invariant; nothing changes).

═══ FILES ═══

  src/importing.ts: extend importBucket to detect source-ws-subdir invocation; wire --source-ws filter; new typed errors (ImportSourceNotInBucketError; reuse ImportBucketInvalidError for the 'no parent manifest' case).
  src/cli/workstream.ts: extend the import subcommand with `--source-ws <names...>`; help text uses the dual-form stock phrase.
  test/importing.test.ts: extend with:
    1. Form 1: import exports/mu/roadmap-v0-2 ⇒ only roadmap-v0-2 restored.
    2. Form 2: import exports/mu --source-ws roadmap-v0-2 ⇒ only that one.
    3. Form 2 multi: --source-ws X,Y on a bucket of 3 ⇒ X+Y, not Z.
    4. Form 1 + --workstream rename: per-ws subdir + --workstream new-name ⇒ restored under new name.
    5. Form 2 with bad name: ImportSourceNotInBucketError; nothing committed.
    6. Form 1 against an orphan source-ws subdir (no parent bucket): ImportBucketInvalidError with helpful message.
  docs/USAGE_GUIDE.md: extend the import section.
  CHANGELOG.md (v0.3 unreleased): one line.

═══ SCOPE ═══

  ~80 LOC SDK + ~30 LOC CLI + ~120 LOC tests + ~10 LOC docs.

═══ ANTI-FEATURES ═══

  - DON'T support --source-ws against a Form 1 dir (per-source-ws subdir already implies a single source). Errors: 'cannot pass --source-ws when <dir> is itself a source-ws subdir; drop the flag'.
  - DON'T add --only <task-id-glob> for sub-source-ws partial. The unit of import is the source-ws (matches the unit of archive add / archive remove). If task-level cherry-pick is wanted later, file separately.
  - DON'T auto-prompt 'this bucket has 2 sources; which would you like?' Anti-interactive; pass the flag explicitly.

═══ PROMOTION ═══

  - Real-user friction: just hit during round-trip dogfood (this filing).
  - Substrate ready: importBucket already walks per-source-ws; just gain a filter + a detection branch.
  - Fits in <300 LOC: yes (~150 incl. tests).

PROMOTE for v0.3.

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close workstream_import_partial_source_ws -w mufeedback-v03 --evidence 'two forms (per-ws path + --source-ws CSV) + tests + docs'
```
