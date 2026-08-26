# scripts/

Sidecars. Nothing in here is wired into the `mu` binary, nothing is in
`src/`, and nothing here is imported by production code. Each script is
run by hand, by an operator, for a one-time job.

---

## `migrate-to-1.0.ts` — the mu 0.4.x → 1.0 data escape hatch

mu 1.0 is a **clean break**. `openDb` refuses every pre-v9 DB with
`SchemaTooOldError` (exit 4), there is no in-process migration ladder,
and `CURRENT_SCHEMA` carries no v8 knowledge. That decision stands and
this script does not change it. This is a **separate artifact you run
once, by hand, against a copy** — it carries your pre-1.0 tasks, edges,
notes and log into a brand-new v9 DB.

### Back up first

```bash
# 1. STOP. Copy the old DB somewhere you will still have it in a year.
cp ~/.local/state/mu/mu.db ~/mu-pre1.0-backup-$(date +%Y%m%d).db

# 2. Move the live old DB aside. (Do NOT delete it.)
mv ~/.local/state/mu/mu.db ~/.local/state/mu/mu.db.old

# 3. Import it into a NEW file.
npx tsx scripts/migrate-to-1.0.ts ~/.local/state/mu/mu.db.old --out /tmp/mu-new.db

# 4. Verify — this is the check that matters.
MU_DB_PATH=/tmp/mu-new.db mu doctor --deep     # must report NO drift
MU_DB_PATH=/tmp/mu-new.db mu workstream list
MU_DB_PATH=/tmp/mu-new.db mu task list -w <your-workstream>

# 5. Swap it in.
mv /tmp/mu-new.db ~/.local/state/mu/mu.db
```

**Keep the old DB indefinitely.** There is no path back. mu 1.0 cannot
write a v8 file and this importer is one-way. Storage is cheap; the DB
is a few megabytes; your task history is not reproducible. If you ever
need something the import did not carry (see below), that file is the
only place it exists.

### Flags

| flag | effect |
| --- | --- |
| `--out <path>` | target path. Default: the source with a `.v9.db` suffix. |
| `--force` | overwrite an existing target. Off by default. |
| `--drop-logs` | do not carry `agent_logs` into the ops log. |
| `--drop-archives` | proceed past pre-1.0 archives, dropping them. |

### The contract

- **Read-only on the source.** Opened with `readonly: true`; the script
  refuses to run when source and target resolve to the same file, and
  prints the source's sha256 before and after so you can see it did not
  change.
- **Fresh target, never in place.** An existing target needs `--force`.
- **Ops, not rows.** v9's entity tables are a PROJECTION of the ops log.
  A row inserted behind the log would be invisible to sync,
  unrecoverable by `mu rebuild`, and reported as drift by
  `mu doctor --deep`. So the importer emits one `put` op per source row
  and lets the normal apply path materialise the tables — the same path
  sync ingest and rebuild use.
- **Source-ordered history.** Each op's HLC is minted from the source
  row's `created_at`, so `mu log` reads like the history actually
  happened. Tasks are ordered ahead of the edges and notes that
  reference them; a source that violates that (a note timestamped
  before its task) is a REFUSAL, not a silent drop.
- **One group.** Every op shares one synthetic `group_id` with intent
  `migrate.v8` (`migrate.v8-log` for carried log lines), because it was
  one operator action. `mu log` renders it as an import rather than
  pretending each row was a live edit.

### What comes across

`workstreams`, `tasks`, `task_edges`, `task_notes`, and (unless
`--drop-logs`) `agent_logs`.

Task notes are a **grow-only set** in v9, identified by
`(task, author, content)` — a note's surrogate id is assigned by
whichever machine inserted it and is not portable. v8 had no such
constraint, so byte-identical duplicate notes on one task merge into
one row. The importer counts them and says so.

Carried log lines land as ops with entity `event`, which is log-only
and NOT in `SYNCED_ENTITIES` — so they show up in `mu log` and in
`mu rebuild`, and they never ship to a peer. That is the honest status
of a carried log line: it is this machine's history.

### What does NOT come across

The script prints this table on every run, with counts, so nothing is
dropped silently.

| v8 table | why not |
| --- | --- |
| `agents` | `pane_id` names a tmux pane on a tmux server that no longer has it. Re-spawn instead. |
| `vcs_workspaces` | absolute paths. Re-create with `mu workspace create`. |
| `snapshots` | the table is gone in v9. The `.db` files are still on disk — keep or bin them yourself. |
| `workstream_sync` | superseded by `sync_peers`, which is per-machine and rebuilt on first sync. |
| task owners (`tasks.owner_id`) | an FK into the machine-local `agents` table. Ownership never syncs and cannot be reconstructed. Re-claim what you are working on. |
| `archives` + `archived_*` | see below. |

### Archives: an honest refusal

**Pre-1.0 archives of destroyed workstreams cannot be faithfully
reconstructed.** v8 stored a column SUBSET of the archived rows in
`archived_tasks` / `archived_edges` / `archived_notes`. A v9 archive is
a MARKER pinning a point in the ops log, and the ops a marker would
need do not exist — v8's `workstream destroy` deleted rows rather than
writing tombstones. Anything synthesized would pin the wrong moment: a
marker over the imported LIVE workstream pins its CURRENT state, not
its state at archive time.

So the script REFUSES when the source has archives, rather than
producing a half-archive. Your options, in order of preference:

1. **Before upgrading**, export them with mu 0.4.x:
   `mu archive show <label> > <label>.txt`
2. Re-run with `--drop-archives` to import the tasks, then carry the
   archives across with `restore-pre1.0-archives.ts` (below).
3. Keep the old DB (you should anyway) and read them with `sqlite3`.

### Why this one is kept

`scripts/migrate-v4-to-v5.ts` was deleted after it landed, per the
temp-impl-artifact rule: it crossed a pre-release schema, so once
everyone was on v5 nobody could ever need it again.

This one is different. It crosses a MAJOR VERSION that real users cross
on their own schedule, possibly months apart, possibly on a second
machine they had not touched since. A deleted script is useless to
someone upgrading in six months. It stays until 1.1 at the earliest,
and is covered by `test/migrate-to-1.0.integration.test.ts` so it cannot rot
silently.

---

## `restore-pre1.0-archives.ts` — carrying pre-1.0 ARCHIVES across

The companion to the above, for the case it refuses.

### Why the blanket refusal is too strong

The argument above says a v8 archive cannot be reconstructed, because a
v9 archive is a MARKER pinning the ops log and v8's `workstream destroy`
deleted rows instead of writing tombstones, so the ops a marker would
pin do not exist.

Both halves are true. The conclusion does not follow. v8's
`archived_tasks` / `archived_edges` / `archived_notes` kept enough of
each row to **synthesize** those ops: `source_workstream`,
`original_local_id`, title, status, impact, effort, and the original
created/updated timestamps. So the missing ops are not needed — they can
be minted from the archive's own copy, the same ops-not-rows way
`migrate-to-1.0.ts` mints live ones, with a marker pinned directly on
top. The marker then pins exactly what the archive recorded, because the
ops beneath it ARE the archive.

### Where it is exact and where it is not

**Exact** when the source workstream no longer exists. The minted ops
are that workstream's whole history, the marker sits on top, and
`mu archive export` reproduces the archived rows.

**Approximate** when the source workstream is still live. A marker is a
point in one shared log, so a marker written today pins the workstream's
CURRENT state, not its state on the archive date. That is the original
objection and here it is real. The script does not paper over it: it
compares the archived rows against the live ones FIELD BY FIELD and
refuses unless they agree. Where they agree, "current" and
"archive-time" are the same rows and the pin is honest.

### Usage

First dump the v8 archives to JSON (mu 1.0 cannot read them):

```bash
# one <label>.json per archive, with archived_tasks/_edges/_notes/_events
sqlite3 ~/.local/state/mu/mu.db.old ...   # or any JSON dump you like
```

Then, against a COPY:

```bash
npx tsx scripts/restore-pre1.0-archives.ts <dir> --db <target.db> --dry-run
npx tsx scripts/restore-pre1.0-archives.ts <dir> --db <target.db>
MU_DB_PATH=<target.db> mu archive list
MU_DB_PATH=<target.db> mu doctor --deep    # must report NO drift
```

| flag | effect |
| --- | --- |
| `--db <path>` | target DB. Default: the default DB. |
| `--dry-run` | plan and report, write nothing. |
| `--label <l>` | restore only this archive. Repeatable. |
| `--drop-events` | do not carry `archived_events` into the log. |
| `--allow-divergent` | proceed when a live row disagrees with the archive. |

### What comes across

One `put` op per archived task, edge and note, plus (unless
`--drop-events`) the archived event log, plus one marker per source
workstream. Ops are ordered by the source timestamp with HLCs minted
from it, so `mu log` reads like the history happened; markers are
emitted LAST so `nextHlc`'s monotonicity puts them above everything they
pin, even where the recorded wall clocks disagree.

### What does NOT come across

Task owners. `owner_name` is recorded in v8's archive, but v9 ownership
is an FK into the machine-local `agents` table (`src/apply.ts` §
`NEVER_APPLY`), so there is nothing on this machine for a name to point
at. The script counts them and says so.

### Status

Verified end to end against a real pre-1.0 DB: 680 tasks, 551 edges and
1376 notes across two archives, round-tripped through
`mu archive export` with zero field mismatches and no drift. **Not yet
covered by a test** — unlike `migrate-to-1.0.ts`, which has one
precisely so it cannot rot. Add one before relying on it a second time.
