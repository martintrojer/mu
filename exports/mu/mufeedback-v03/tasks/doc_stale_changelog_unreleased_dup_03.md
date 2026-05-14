---
id: "doc_stale_changelog_unreleased_dup_03"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: "worker-3"
created_at: "2026-05-10T13:23:17.148Z"
updated_at: "2026-05-10T13:47:13.471Z"
blocked_by: []
blocks: []
---

# docs: CHANGELOG.md has both [Unreleased] and [0.3.0] — unreleased] sections; the v0.3 work is split across two unreleased buckets

## Notes (1)

### #1 by "reviewer-3", 2026-05-10T13:23:34.061Z

```
FILES: CHANGELOG.md:11-200 ([Unreleased]), :211 ([0.3.0] — unreleased)
FINDING: CHANGELOG has TWO open release buckets above [0.2.0]:
  (1) `## [Unreleased]` (line 11) holds the latest v0.3-wave items: cross-workstream `mu task claim --for`, `mu task wait --on-stall`, idle agent flag, scripts/ removal, `mu hud` removal, cli.ts split, release auto-flip, `mu state --hud/--mission`, `mu task wait` cross-workstream + reconcile, destroy --empty tmux-only, multi-status union, hud --workstreams unification, workspace_create_typed_no_agent_error.
  (2) `## [0.3.0] — unreleased` (line 211) holds approvals removal, bucket export v2, schema v6/v7, alphabetical --help, workstream import, hud multi-workstream, archive SDK + CLI, destroy --archive/--empty.
This is incoherent — both buckets describe the same v0.3 wave (every item has shipped to main; package.json says "0.3.0-dev"). A reader trying to write "v0.3 added X" has to manually merge the two sections, and items in [Unreleased] sit semantically AFTER [0.3.0] — unreleased] which reads as "post-0.3 work" but is actually contemporaneous.
WHY: CHANGELOG is "single source of truth for the verb list, schema, env vars" per AGENTS.md. Two unreleased sections fragment that truth.
FIX-SKETCH: merge `[Unreleased]` into `[0.3.0]`; rename to a single header (e.g. `## [0.3.0] — YYYY-MM-DD` once tagged, or `## [0.3.0] — unreleased` if not yet released). Within the merged section, the existing Added / Removed / Changed / Fixed / Schema / Breaking ordering should be preserved (de-dup any overlapping entries — none currently overlap, but verify the `mu hud` / `merge_state_into_hud_render_mode` is in only one place).
```
