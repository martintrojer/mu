# scripts/

Retained migration sidecars. Nothing here is wired into the `mu` binary or imported by production code. Run these scripts manually against a preserved source DB.

## `migrate.ts` — v8 or v9 to v10

`openDb` does not migrate existing databases in place. `scripts/migrate.ts` detects a v8 or v9 source and writes a fresh v10 target:

```bash
npx tsx scripts/migrate.ts <source.db> --out <fresh-v10.db>
```

The source is opened read-only. The script refuses source and target paths that identify the same file, refuses an existing target unless `--force` is explicit, and prints the source SHA-256 before and after.

### Exact upgrade recipe

Stop every `mu` process before copying or swapping the DB.

```bash
DB=${MU_DB_PATH:-$HOME/.local/state/mu/mu.db}
BACKUP="$HOME/mu-v9-backup-$(date +%Y%m%d-%H%M%S).db"
TARGET="${DB}.v10"

# 1. Preserve the source, including any committed WAL pages.
# Keep this backup indefinitely.
sqlite3 "$DB" ".backup '$BACKUP'"
shasum -a 256 "$BACKUP"

# 2. Migrate the backup, never the live path.
npx tsx scripts/migrate.ts "$BACKUP" --out "$TARGET"

# 3. Verify the fresh target. Deep doctor must report zero drift.
MU_DB_PATH="$TARGET" mu doctor --deep
MU_DB_PATH="$TARGET" mu workstream list
MU_DB_PATH="$TARGET" mu task list -w <workstream>

# 4. Swap only after verification. Retain the old DB beside it.
mv "$DB" "${DB}.v9-kept"
mv "$TARGET" "$DB"

# 5. Reconcile carried machine-local rows against current reality.
mu doctor
```

If verification fails, do not swap. The original DB and backup remain unchanged.

### Flags

| Flag | Effect |
| --- | --- |
| `--out <path>` | Target path. Default: source path with a `.v10.db` suffix. |
| `--force` | Remove an existing target before writing. Off by default. |
| `--drop-logs` | v8 only: omit legacy `agent_logs`. |
| `--drop-archives` | v8 only: explicitly discard pre-1.0 archives that cannot be represented faithfully. |

### v9 → v10 behavior

The complete v9 ops log is copied byte-for-byte at the op-field level. During projection, legacy task status values are normalized without rewriting history:

- `REJECTED` projects as `OPEN` and gains `MIGRATION: previous status was REJECTED`.
- `DEFERRED` projects as `OPEN` and gains `MIGRATION: previous status was DEFERRED`.

The normalization is in the shared apply path. Old peer segments, `mu sync --from`, and `mu rebuild` therefore project legacy status ops as `OPEN` instead of violating the v10 task constraint. The original legacy payload remains in `ops` as evidence.

Carried from v9:

- workstreams, tasks, edges, notes, and the complete ops history;
- `machine_identity`, including the persisted HLC clock;
- `sync_peers` watermarks;
- agents whose workstream survives;
- workspaces whose referenced agent and workstream survive;
- task ownership whose referenced agent survives.

Machine-local rows are structurally valid but cannot be proven operational during migration. A pane id may no longer name a live pane, and an absolute workspace path may no longer exist or belong to the recorded VCS backend. Run `mu doctor` after the swap; reconciliation decides pane reality. Keep the source DB as the audit copy.

### v8 → v10 behavior

The v8 path retains the former pre-1.0 importer behavior but now targets v10 directly. It synthesizes ops for workstreams, tasks, edges, and notes, then uses the normal apply path. Optional `agent_logs` become log-only `event` ops.

Not carried from v8:

| Source data | Reason |
| --- | --- |
| agents and task owners | Pane ids predate the current registry and cannot be validated safely. |
| VCS workspaces | Absolute paths cannot be asserted valid across the substrate break. |
| snapshots | The table no longer exists; retain the files separately. |
| workstream sync state | Replaced by per-machine `sync_peers`. |
| archives | The old storage model cannot be represented faithfully; migration refuses unless `--drop-archives` is explicit. |

The v8 path may merge byte-identical notes because v10 note identity is `(task, author, content)`. The report names the count.

### Why this script is retained

It crosses released schema boundaries that users may encounter months later. Keeping one auto-detecting sidecar avoids a chain of version-specific migration scripts while preserving the rule that production startup never performs an in-place migration.
