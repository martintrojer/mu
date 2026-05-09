---
id: "v5_prune_v4_fallback_branches"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "worker-mf-1"
created_at: "2026-05-09T13:38:20.167Z"
updated_at: "2026-05-09T14:23:07.026Z"
blocked_by: ["bug_v5_name_clash_silent_misroute"]
blocks: ["docs_staleness_review_capstone"]
---

# v5 cleanup: prune every 'preserves the v4 SDK contract' fallback branch in src/ (operator pre-1.0; no compat needed)

## Notes (2)

### #1 by π - mu, 2026-05-09T13:39:11.291Z

```
SURFACED LIVE post-v5-landing: grep for "v4" / "legacy" / "backward-compat" in src/ shows ~25 hits across 8+ files where the v5 SDK code still carries a fallback branch labelled "preserves the v4 SDK contract". Per operator: pre-1.0, no third-party consumers, and v4 has been deleted (migrations.ts is gone, the loud-fail hook in openDb refuses any pre-v5 DB). Those fallbacks are dead-pretending-to-be-alive: the path can never trigger, but readers of the code don't know that.

═══ KNOWN OFFENDERS (from grep -rn "v4\|legacy\|backward.compat" src/) ═══

  src/agents.ts:104,136,191
    getAgent(db, name) — "v4 SDK shape: name was globally unique"
    Returns first match across workstreams. Per-workstream uniqueness post-v5 means this is the silent-misroute bug
    (bug_v5_name_clash_silent_misroute, in flight). Once that bug ships, getAgent's signature
    becomes (db, workstream, name) and the v4 fallback can be deleted.
  
  src/tasks.ts:181-182, 281, 384, 599
    getTask(db, localId) — same shape; same fix; same fallback to delete.
    listReady / listBlocked / listGoals — comments reference "v4 row shape" for the JSON projection.
    addTask seed-id — backward-compat for v4 contract.
  
  src/approvals.ts:39, 178, 211
    listApprovals + addApproval — "v4 contract permitted nullable workstream"; "v4 was 'first match'".
    workstream_id is now NOT NULL (per design doc); the "rows from migration may be edge cases"
    handling has nothing to handle anymore (all rows are v5-shaped post-migration).
  
  src/workspace.ts:56, 380
    "preserves the v4 contract" comments around createWorkspace + freeWorkspace.
  
  src/cli.ts:791
    Some classifyError or output shape preserving v4 expectations.
  
  src/logs.ts:47
    Same shape — log emission preserves a v4 contract.
  
  src/tasks/claim.ts:278, 286
    "the legacy claim-protocol identity step" / "Pane title is still the legacy identity"
    These may be load-bearing (the pane-title parse is the in-pane LLM's identity discovery)
    rather than v4 fallback. Audit, don't blanket-delete.
  
  src/tmux.ts:696
    "Adopted / legacy panes that haven't been re-titled by mu" — also probably load-bearing
    (real handling for adopted panes, not v4 fallback).

═══ DECISION CRITERION FOR EACH BRANCH ═══

For each "v4" / "legacy" / "backward-compat" hit in src/:

  Q1. CAN the v4 path actually trigger today?
      - openDb refuses pre-v5 DBs (loud-fail hook).
      - migrate-v4-to-v5.ts has converted every known DB.
      - Tests are 836/836 green on v5 fixtures only.
      → If NO real trigger possible: DELETE the branch + its comment. Adjust the path to assume v5 invariants directly.
      → If YES it could trigger (e.g. the path handles a USER input that COULD shape like v4): KEEP, but rename comment from "v4" to the actual semantic ("supports operator-typed bare-id" or whatever).
  
  Q2. Is "legacy" actually a synonym for "the documented behaviour we still want"?
      Some comments say "legacy" when they mean "the original, still-current way" (e.g. pane-title parsing).
      → If YES: rename comment to drop "legacy" — it's misleading, the path isn't legacy at all.
      → If NO: same as Q1, delete.

═══ EXAMPLES ═══

  KEEP (rename comment):
    src/tasks/claim.ts:278 "the legacy claim-protocol identity step (pane title parse)"
    → Pane title parsing is the IN-USE identity-discovery for in-pane LLMs. Not legacy.
    Rename to: "the pane-title identity step (in-pane LLM identity)".
  
  DELETE (no possible trigger):
    src/agents.ts:191 "v4 SDK shape getAgent(db, name) is preserved by returning the first match"
    → After bug_v5_name_clash_silent_misroute lands, getAgent's signature requires workstream.
    The "first match" branch can never fire. Delete it + the branch + the comment.
  
  DELETE (no possible trigger):
    src/approvals.ts:178 "v4 contract permitted nullable workstream"
    → Schema enforces NOT NULL. No row in the DB can have nullable workstream.
    The handling code has nothing to handle. Delete.

═══ SHIP ORDER ═══

  This task is BLOCKED BY bug_v5_name_clash_silent_misroute.
  Reason: bug_v5_name_clash_silent_misroute is the load-bearing fix that makes the agents.ts /
  tasks.ts "first match" fallbacks unreachable. Until that lands, deleting them would actively
  break the silent-misroute behaviour (which is wrong but currently relied on).
  
  Once bug_v5_name_clash_silent_misroute closes:
    - The (db, workstream, name) signatures are mandatory.
    - This task scans every "v4 / legacy / backward-compat" comment, deletes the dead branches,
      and renames the misleading comments.

═══ EDGES ═══

  Block: docs_staleness_review_capstone (so docs reflect a v4-fallback-free codebase).
  Blocked by: bug_v5_name_clash_silent_misroute (per ship order above).

═══ DELIVERABLE ═══

  Single commit "v5 cleanup: prune v4 fallback branches in src/" with:
    - Every dead "v4 contract" branch deleted.
    - Every "legacy" comment that's actually current renamed.
    - CHANGELOG entry under [Unreleased] / Removed.
    - Net negative LOC delta (probably ~ -50-100 LOC).
    - Gate green at 836/836+.

═══ ANTI-FEATURE GUARDRAILS ═══

  - Don't delete a branch just because it has the word "v4" in the comment. Verify it's unreachable first.
  - Don't blanket-rename comments. Pane-title parsing IS the current identity step; saying so isn't a "legacy" rename.
  - Don't add `// v4: removed` tombstones. git history is the tombstone.
  - Don't bundle this with bug_v5_name_clash_silent_misroute. That task's diff should be the FIX; this task's diff is the CLEANUP. Two separate readable commits.
```

### #2 by π - mu, 2026-05-09T13:39:44.949Z

```
SCOPE SIMPLIFIED (per operator): just remove all v4 fallback branches. No audit-per-case framing. Pre-1.0; no compat needed.

═══ THE NEW DELIVERABLE ═══

ONE commit:

  1. grep -rn "v4\|backward.compat" src/  →  for every hit, delete the branch + its comment.
  2. grep -rn "legacy" src/  →  for every hit, evaluate: is the WORD legacy actually correct?
       - "the legacy claim-protocol identity step (pane title)" → pane-title parsing IS the current
         identity step; rename comment, don't delete code.
       - "Adopted / legacy panes that haven't been re-titled" → real handling for adopted panes;
         rename "legacy" → "adopted" in the comment, don't delete code.
       - Anything else with "legacy" tagged on a v4 fallback path → delete the branch.
  3. Tighten function signatures: every public function that had a v4-fallback branch can now
     ASSUME the v5 invariant. Drop the `?`-optional workstream args; mandate them. (e.g. getTask
     becomes getTask(db, workstream, localId) with NO overload that takes just localId.)
  4. Delete any tests that exercised the v4-fallback path. Add a CI grep guard:
     scripts/grep-v4-references.sh that fails if any future commit re-introduces "v4" or
     "backward-compat" in src/.
  5. CHANGELOG entry under [Unreleased] / Removed.

═══ EXAMPLES — JUST DELETE ═══

  src/agents.ts:104,136,191         (getAgent first-match across workstreams) → DELETE
  src/tasks.ts:181-182,281,384,599  (getTask + variants) → DELETE
  src/approvals.ts:39,178,211       (workstream nullable handling, slug first-match) → DELETE
  src/workspace.ts:56,380           (createWorkspace/freeWorkspace v4 contract) → DELETE
  src/cli.ts:791                    (classifyError/output v4 shape) → DELETE
  src/logs.ts:47                    (log emission v4 contract) → DELETE

═══ EXAMPLES — RENAME COMMENT, KEEP CODE ═══

  src/tasks/claim.ts:278,286        "legacy claim-protocol identity step" → "pane-title identity step"
  src/tmux.ts:696                   "Adopted / legacy panes" → "Adopted panes (titled by adopt, not spawn)"

═══ SHIP ORDER ═══

Still blocked by bug_v5_name_clash_silent_misroute (which makes the silent-misroute branches actually unreachable; deleting before that lands would change behaviour for the worse).

Once that lands → claim this → mechanical sweep + delete.

SCOPE: ~0.5 days. Mostly mechanical deletion. ~ -100 to -200 LOC net.

GATE: typecheck + lint + test + build green. Tests should still be 836/836+ — the v4 fallback paths had no v5-fixture coverage to begin with (because v5 fixtures don't trigger them).
```
