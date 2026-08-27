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

Pre-1.0 archives are not carried into 1.0. The archive namespace and
its storage model were removed; the importer will not silently turn
archived rows into live work.

The script REFUSES when the source has archives. Your options:

1. **Before upgrading**, export them with mu 0.4.x.
2. Re-run with `--drop-archives` to import the tasks and drop the archives.
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
