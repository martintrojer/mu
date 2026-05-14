---
id: "review_repo_export_bucket_index_not_additive"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.2
roi: 225.00
owner: "worker-3"
created_at: "2026-05-12T11:14:38.366Z"
updated_at: "2026-05-12T13:08:09.727Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW med: additive bucket export rewrites top-level INDEX for only current source

## Notes (3)

### #1 by "worker-2", 2026-05-12T11:14:38.685Z

```
FILES: src/exporting.ts:386-534, especially 511-516; src/exporting.ts:242-305.
FINDING: `renderToBucket()` preserves prior sources in `manifest` and README, but the top-level `INDEX.md` is regenerated from only `input.sources`. The inline comment admits the compromise: a one-source `mu workstream export --out <bucket>` can shrink the bucket INDEX to only that source while README/manifest still claim multiple sources. That makes the bucket internally inconsistent and violates the additive-export contract described at the top of the file.
RECOMMENDED FIX: Keep enough per-task metadata in the manifest (title/status/impact/effort or a compact task summary) to render the union index from `manifest.sources`, or read existing per-source task markdown/index files for untouched siblings before rewriting the bucket index. If neither is worth it, stop writing a top-level union INDEX for one-source refreshes and document the narrower contract.
```

### #2 by "π - mu", 2026-05-12T12:42:33.427Z

```
DECISION (orchestrator triage): FULL FIX per the audit's recommended path.

Implementation per the original note:
1. src/exporting.ts manifest schema: extend each entry in manifest.sources[].tasks[] with the compact summary fields needed to render an INDEX entry — at minimum: name, title, status, impact, effortDays. (Today only the source-name + count is captured.)
2. src/exporting.ts renderToBucket: when building the top-level INDEX.md, iterate manifest.sources (NOT input.sources) to render the union view. Existing per-source markdown stays as-is; INDEX is the cross-source nav.
3. Manifest schema bump: add a manifest_version field (1 → 2). On reading an older bucket (v1) for additive re-export, auto-migrate by inferring task summaries from the per-source markdown OR fall back to the current behaviour (with a warning event).
4. test/exporting.test.ts: extend with an additive-export round-trip — export source A, then export source B with --out same-bucket, verify INDEX shows BOTH sources.
5. CHANGELOG.md (under v0.4.0 polish): bullet under 'Bug fixes' cross-ref the inline 'compromise' comment in src/exporting.ts:511-516 (which now goes away).
6. docs/USAGE_GUIDE.md mu workstream export section: confirm the additive contract in writing.

Estimated diff: +200 LOC, -50 LOC. Touches the export contract — low blast radius (export is a write-only verb, no other code reads buckets directly).

⚠️ FINAL ACTION ⚠️
mu task close review_repo_export_bucket_index_not_additive -w tui-impl --evidence '<sha>: union INDEX rendered from manifest.sources + manifest schema v2'
```

### #3 by "worker-3", 2026-05-12T13:08:09.727Z

```
CLOSE: 2fac1d7: union INDEX rendered from manifest.sources + manifest schema v2
```
