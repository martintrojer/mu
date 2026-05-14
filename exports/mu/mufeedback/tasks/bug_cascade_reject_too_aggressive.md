---
id: "bug_cascade_reject_too_aggressive"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.3
roi: 100.00
owner: null
created_at: "2026-05-08T11:06:14.468Z"
updated_at: "2026-05-08T11:24:30.678Z"
blocked_by: []
blocks: []
---

# BUG: mu task reject --cascade silently sweeps dependents that may have independent merit

## Notes (1)

### #1 by "π - mu", 2026-05-08T11:06:14.592Z

```
SURFACED LIVE during roadmap-v0-2 hud cleanup.

REPRO
1. hud_design blocks hud_extension_skeleton blocks hud_widget_impl blocks hud_dogfood.
2. hud_extension_skeleton + hud_widget_impl rejected (pi-extension framing dropped).
3. mu task reject hud_widget_impl --cascade
   -> hud_dogfood (transitive dependent) ALSO got REJECTED, even though that task should be
      kept and repurposed.

ROOT CAUSE
findOpenDependents in src/tasks.ts walks every transitive open dependent and applies the same
status. There's no opportunity for the user to inspect which dependents will be touched
before they're touched.

WHAT'S WRONG
The --cascade docstring says "apply the same status to every transitive dependent". That's
literally what it does — but in practice some dependents have INDEPENDENT MERIT (e.g.
hud_dogfood was always going to be "do a dogfood pass", regardless of whether the
implementation was a pi extension or a verb). Sweeping them as "rejected" loses that
information until reopened.

PROPOSED FIX (small)
1. Default --cascade behaviour: print the list of dependents that WILL be swept, with their
   titles, and require either:
   (a) --yes to actually proceed, OR
   (b) re-running with --cascade --yes (mirroring `mu workstream destroy --yes`).
2. Or: dry-run by default; --yes commits.
3. Either way: surface the affected dependents BEFORE the action, not after.

OR ALTERNATIVELY
Drop --cascade entirely. The current TaskHasOpenDependentsError already lists the dependents
and tells the user what to do (reject one at a time, or unblock the edge). Maybe that's
sufficient — the operator should think about each dependent on its own.

ESTIMATE: ~30 LOC for the dry-run + confirm pattern. ~5 LOC for the drop --cascade option.
Promotion criterion: we just hit it once; if it surfaces again, ship one of the fixes.
```
