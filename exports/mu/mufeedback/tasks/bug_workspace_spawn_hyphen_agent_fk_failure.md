---
id: "bug_workspace_spawn_hyphen_agent_fk_failure"
workstream: "mufeedback"
status: REJECTED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-08T16:50:52.735Z"
updated_at: "2026-05-09T06:42:38.041Z"
blocked_by: []
blocks: []
---

# BUG: workspace spawn fails FK for hyphenated agent names

## Notes (2)

### #1 by "π - infer-rs", 2026-05-08T16:50:52.863Z

```
FILES: mu agent spawn --workspace; infer-rs workstream.
COMMANDS: mu agent spawn sil-a -w infer-rs --cli pi-meta --command 'pi-meta --no-solo' --workspace --workspace-project-root /Users/mtrojer/infer-rs; then mu agent spawn sila with same flags.
FINDINGS: After workspace fixes, correct-root no-hyphen spawn succeeds (sila) and creates a git workspace/agent. The otherwise identical hyphenated agent name sil-a fails with stderr: error: FOREIGN KEY constraint failed, no orphan left. Existing agents like reviewer-1 prove hyphens are generally accepted for non-workspace agents, so the issue appears specific to workspace spawn/staging or workspace row/cleanup path with hyphenated agent names.
DECISION: Use no-hyphen agent names as workaround for infer-rs parallel tracks.
NEXT: Add regression for --workspace spawn using a hyphenated valid agent name. Inspect SQL parameter binding or any code path that treats agent names as identifiers/path segments during placeholder insert/workspace row insert/delete.
VERIFIED: sil-a exit=1 FK; sila exit=0 with backend=git and workspace row.
ODDITIES: fkrepro2 also succeeded; likely names with digits are fine.
```

### #2 by "worker-mf-2", 2026-05-09T06:42:34.515Z

```
FILES: src/agents/spawn.ts; src/cli.ts (dryRun call sites); commit 462e3a7.

COMMANDS:
  mu workstream init test-hyphen-bug
  mu agent spawn {nohyph, no-hyph, sila, sil-a} -w test-hyphen-bug --workspace --workspace-project-root /Users/mtrojer/hacking/mu  # all 4 succeeded, exit=0
  mu workstream init test-hyphen-infer-rs
  mu agent spawn {hyphen-test, another-hyph, nohyphhere} -w test-hyphen-infer-rs --workspace --workspace-project-root /Users/mtrojer/infer-rs --cli pi-meta --command 'pi-meta --no-solo'  # all 3 succeeded, exit=0
  mu workstream destroy -w test-hyphen-bug --yes; mu workstream destroy -w test-hyphen-infer-rs --yes  # cleaned up

FINDINGS: Cannot reproduce on either small-repo (mu, ~hundreds of files) or large-repo (infer-rs, 13k+ files) with current main (HEAD d1d43e0). Hyphenated and non-hyphenated names BOTH spawn cleanly --workspace. The hyphen-vs-no-hyphen pattern in note #370 was a timing coincidence: commit 462e3a7 (bug_agent_spawn_workspace_fk_failure, May 8 17:55) fixed a race where read-only verbs (mu hud / mu state / bare mu / mu agent attach / mu doctor) triggered reconcile() during the 2-3s window between the placeholder agent INSERT and the workspace row INSERT. Reconcile saw '%pending-<name>' as a non-live pane and pruned the row; the subsequent vcs_workspaces INSERT then failed its agent FK. The 462e3a7 commit message explicitly notes "infer-rs hypothesised the bug was about hyphenated agent names; that's a red herring (verified: hyphenated names spawn fine after this fix)" and confirms a `fk-hyphen-test` agent spawned clean live.

Commit 9512114 (workspace_create_partial_dir_on_failure, May 9) further hardened the cleanup-on-throw path so even if a future race surfaces, the on-disk dir won't be left as an orphan blocking the next attempt.

DECISION: REJECT — already fixed by 462e3a7 (race) + 9512114 (cleanup). The original symptom ("FOREIGN KEY constraint failed, no orphan left") was timing-dependent on the user's external `watch mu hud`/`watch mu state` loops, not on the agent name's hyphen. Re-opening would be appropriate only if the user reproduces against current main with NO concurrent mu read verbs running.

NEXT: None. If a future report shows the same FK error reproducibly without external watch-loops, file a new task with the watch-loop status explicitly noted.

VERIFIED: 7 spawn attempts (4 small-repo + 3 large-repo, mix of hyphen/no-hyphen), all exit=0, workspace rows created. Local cleanup complete (both test workstreams destroyed, no leftover panes/dirs).

ODDITIES: None — the absence of repro IS the finding.
```
