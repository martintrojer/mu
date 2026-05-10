---
id: "doc_stale_output_labels_audit_approve"
workstream: "mufeedback-v03"
status: REJECTED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-10T13:22:07.702Z"
updated_at: "2026-05-10T13:30:20.555Z"
blocked_by: []
blocks: []
---

# docs: OUTPUT_LABELS_AUDIT.md still has full approve/hud/whoami/my-tasks rename rows for removed verbs

## Notes (2)

### #1 by reviewer-3, 2026-05-10T13:22:24.348Z

```
FILES: docs/OUTPUT_LABELS_AUDIT.md:1, :11, :54, :59, :131-139, :155 (whoami/my-tasks/my-next), :164-170 (state/hud/sql/doctor/whoami), :205-208 (ApprovalRow), :270 (ApprovalRow rename), :298, :311, :322
FINDING: The doc was the design spec for `output_json_keys_rename_v5` (shipped) but post-v0.3 it still describes:
  (1) An entire `### approve namespace (mu approve ...)` block with rename plans for verbs that no longer exist (:131-139). Same for :54/:59 table rows about `slug` column in `mu approve list`, :205-208 ApprovalRow shape, :270 ApprovalRow rename bullet, :298 + :311 jq recipes for approvals, :322 "approval name" wording.
  (2) `whoami` / `my-tasks` / `my-next` rows (:155, :170) — all merged into `mu me [tasks|next]` per audit_merge_self_verbs_into_mu_me.
  (3) Section `### state / hud / sql / doctor / whoami` (:164) — `hud` row with its own JSON shape (:169) and `whoami` row are stale; `mu hud` is gone (now `mu state --hud`); the `state` rows flat shape should mention the `--hud`/`--mission` render-mode JSON contract from CHANGELOG.
  (4) :1 title "Output labels audit — human columns and `--json` keys after schema v5" — schema is now v7; either bump to v7 or rename the doc to a historical retrospective (since the rename is shipped, the doc role has shifted from "design spec" to "post-mortem of a shipped change").
WHY: Anyone scripting against `mu --json` who hits this doc gets pointed at removed verb shapes and may write recipes for surfaces that dont exist.
FIX-SKETCH: add a top-of-file banner: "Status: shipped in v0.2; superseded for `mu approve` / `mu hud` / `mu whoami` / `mu my-*` (all removed in v0.3 — see CHANGELOG)." Strike or delete the four affected sections; keep the still-correct rename tables for the live entities.
```

### #2 by worker-2, 2026-05-10T13:30:20.434Z

```
parent doc removed; see remove_output_labels_audit_md
```
