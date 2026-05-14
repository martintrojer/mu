---
id: "bug_bare_mu_pane_lookup"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 95
effort_days: 0.3
roi: 316.67
owner: null
created_at: "2026-05-07T17:52:17.069Z"
updated_at: "2026-05-07T18:00:19.769Z"
blocked_by: []
blocks: []
---

# BUG: bare `mu -w <ws>` errors 'can't find pane: 2' immediately after workstream init (no agents yet)

## Notes (2)

### #1 by null, 2026-05-07T17:52:17.162Z

```
REPRO: `mu workstream init roadmap-v0.2 && mu -w roadmap-v0.2`. Workstream is brand new, zero agents, but mission control fails. Error string: 'tmux: tmux list-panes -s -t mu-roadmap-v0.2 -F ... failed (exit 1): can't find pane: 2'. The -s flag means session-scope; the 'pane: 2' is suspicious — tmux may be parsing a colon-prefixed target wrong, OR the format string is being expanded somewhere it shouldn't be.
```

### #2 by null, 2026-05-07T17:53:08.506Z

```
WIDER BLAST RADIUS: also affects `mu state -w roadmap-v0.2` and (presumably) `mu agent list -w roadmap-v0.2`. Anything that runs reconcile against a brand-new workstream with zero agents triggers it. Suspicion: tmux's `list-panes -s -t mu-roadmap-v0.2` is being misparsed, possibly because of the dot/dash content or because the format string contains `#{pane_title}` which can include arbitrary content. Need to check src/tmux.ts listPanesInSession behavior on empty sessions. The mocked unit tests don't catch it because they don't exercise real tmux on an empty session — only integration tests would, and they probably always spawn an agent first.
```
