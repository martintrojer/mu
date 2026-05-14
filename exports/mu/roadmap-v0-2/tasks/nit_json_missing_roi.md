---
id: "nit_json_missing_roi"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-07T18:03:52.299Z"
updated_at: "2026-05-07T18:09:45.802Z"
blocked_by: []
blocks: []
---

# BUG/NIT: mu task next --json (and probably others) emits roi=null instead of computed ROI

## Notes (1)

### #1 by null, 2026-05-07T18:03:52.392Z

```
REPRO: `mu task next -w roadmap-v0-2 -n 5 --json | jq '.[].roi'` returns 'null' for every row, but the table view shows 600.0, 233.3, etc. Likely the JSON serialiser is reading a column that was renamed/removed, or the SQL view exposes ROI but the typed-row mapper drops it. Affects task next, ready, blocked, goals (anything that surfaces ROI). Probably a 5-line fix in the read path.
```
