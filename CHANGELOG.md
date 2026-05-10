# Changelog

All notable changes to mu are recorded here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 lands; pre-1.0 minor versions may include breaking changes
called out under "Breaking" in each entry.

---

## [Unreleased]

- **`mu workstream destroy --empty` now also surfaces unregistered
  `mu-*` tmux sessions** (`destroy_empty_match_tmux_only`). Test
  litter and partial-destroy remnants (DB row gone, tmux session
  survived) are now matched by the same sweep verb. Predicate is
  narrow on the `mu-` prefix; arbitrary tmux sessions are never
  touched. Synthetic `WorkstreamSummary` for tmux-only entries has
  `registered=false`, all counts 0, `tmuxAlive=true`; the dry-run
  table renders an em-dash for the missing `created_at`.

- **`--status` accepts multi (union) on `mu task list`, `mu task next`,
  and `mu approve list`** (`task_list_multi_status_union`). Same
  dual-form as every other multi-value flag (`--status OPEN,CLOSED`,
  `--status OPEN --status CLOSED`, or any mix), case-insensitive,
  deduped. Missing `--status` keeps today's no-filter shape (no auto-
  default to `OPEN ∪ IN_PROGRESS`). Single value is byte-identical to
  today's behaviour. `mu task wait --status` stays single (the verb is
  semantically "wait until reaches THIS status"). New shared helper
  `parseStatusesOption` in `src/cli.ts`; SDK `listTasks` /
  `listReady` / `listApprovals` accept `status?: T | readonly T[]`.
