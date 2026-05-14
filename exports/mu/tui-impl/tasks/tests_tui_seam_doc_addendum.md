---
id: "tests_tui_seam_doc_addendum"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: "worker-3"
created_at: "2026-05-13T14:41:28.394Z"
updated_at: "2026-05-13T15:18:08.266Z"
blocked_by: []
blocks: ["testreview_tui_static_source_grep_pervasive"]
---

# TESTS: write test/README.md note on CaptureStream-vs-source-grep policy

## Notes (3)

### #1 by "π - mu", 2026-05-13T14:41:32.406Z

```
Sub-task of testreview_tui_static_source_grep_pervasive. See `mu task notes testreview_tui_static_source_grep_pervasive -w tui-impl` for the full split rationale.
```

### #2 by "worker-3", 2026-05-13T15:18:05.330Z

```
FILES: test/README.md (new), AGENTS.md, test/_ink-render.ts
COMMANDS: npm run typecheck && npm run lint && npm run test:fast && npm run build (exit 0); git diff --check (exit 0)
FINDINGS: Documentation-only task. Added discoverable CaptureStream-vs-source-grep policy for TUI popup/card behaviour tests, with allowed structural-grep exceptions.
DECISION: Cross-linked from AGENTS.md tests section and test/_ink-render.ts header; skipped CHANGELOG.md to avoid shared-file churn for docs-only note.
VERIFIED: typecheck, lint, fast tests, build all passed.
NEXT: none.
ODDITIES: none.
```

### #3 by "worker-3", 2026-05-13T15:18:08.266Z

```
CLOSE: 5037213: test/README.md added with CaptureStream-vs-source-grep policy
```
