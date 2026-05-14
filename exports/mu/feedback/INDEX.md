# feedback — task index

| id | status | impact | effort | ROI | title |
| --- | --- | --- | --- | --- | --- |
| [`add_mu_workspace_recreate_free_create`](tasks/add_mu_workspace_recreate_free_create.md) | CLOSED | 25 | 0.2 | 125.00 | Add mu workspace recreate (free + create) shortcut |
| [`agent_send_messages_queue_silently`](tasks/agent_send_messages_queue_silently.md) | REJECTED | 15 | 0.3 | 50.00 | agent send messages queue silently behind unresponsive shell tools |
| [`agent_spawn_abort_leaves_orphan_workspace`](tasks/agent_spawn_abort_leaves_orphan_workspace.md) | CLOSED | 18 | 0.3 | 60.00 | agent spawn abort can leave orphan workspace without surfaced cleanup command |
| [`agent_spawn_liveness_check_trips_on`](tasks/agent_spawn_liveness_check_trips_on.md) | CLOSED | 15 | 0.2 | 75.00 | agent spawn liveness check trips on solo-locked CLIs (e.g. pi-meta --solo) |
| [`agent_spawn_model_auth_failure_counts_as_live`](tasks/agent_spawn_model_auth_failure_counts_as_live.md) | CLOSED | 16 | 0.3 | 53.33 | agent spawn with unavailable model/provider counts as live worker until task wait stalls |
| [`agents_close_tasks_without_committing`](tasks/agents_close_tasks_without_committing.md) | CLOSED | 30 | 1 | 30.00 | agents close tasks without committing when prompt lacks explicit FINAL ACTION block |
| [`allow_mu_agent_close_without_discard`](tasks/allow_mu_agent_close_without_discard.md) | CLOSED | 30 | 0.3 | 100.00 | Allow mu agent close without --discard-workspace when workspace is empty |
| [`bare_verb_namespaces_mu_workspace_task`](tasks/bare_verb_namespaces_mu_workspace_task.md) | CLOSED | 12 | 0.1 | 120.00 | bare verb-namespaces (mu workspace / task / agent / archive / snapshot) print nothing and exit 0; should default to --help |
| [`drop_legacy_mu_task_wait_json_fields`](tasks/drop_legacy_mu_task_wait_json_fields.md) | CLOSED | 8 | 0.2 | 40.00 | drop legacy mu task wait --json fields (tasks/allReached/anyReached/elapsedMs/boolean timedOut); keep firing/all/timedOut(array) |
| [`drop_legacyexportlayouterror`](tasks/drop_legacyexportlayouterror.md) | CLOSED | 10 | 0.2 | 50.00 | drop LegacyExportLayoutError + ImportLegacyLayoutError + the v1 export bucket probe (pre-v0.3 format) |
| [`drop_taskrow_localid_duplicate_of_name`](tasks/drop_taskrow_localid_duplicate_of_name.md) | CLOSED | 7 | 0.1 | 70.00 | drop TaskRow.localId duplicate of name (was added 1 day ago for jq recipe symmetry; sole user, prefer single canonical key) |
| [`externally_blocked_tasks_show_as_ready`](tasks/externally_blocked_tasks_show_as_ready.md) | REJECTED | 12 | 0.3 | 40.00 | externally-blocked tasks show as ready; no waiting-on-condition state |
| [`fb_agent_spawn_no_validation`](tasks/fb_agent_spawn_no_validation.md) | CLOSED | 80 | 0.5 | 160.00 | agent spawn silently succeeds when --cli is broken/unavailable |
| [`fb_close_post_emit_commit_hint`](tasks/fb_close_post_emit_commit_hint.md) | CLOSED | 25 | 0.1 | 250.00 | NIT: post-emit Next: hint after mu task close — 'commit your workspace edits before the next wave: cd $(mu workspace path) && git status' |
| [`fb_close_require_clean`](tasks/fb_close_require_clean.md) | DEFERRED | 35 | 0.3 | 116.67 | FEAT: mu task close --require-clean opt-in flag — refuse to close when workspace has uncommitted changes (orchestrator safety net for the 'agent closed without committing' failure) |
| [`fb_task_notes_tail`](tasks/fb_task_notes_tail.md) | CLOSED | 30 | 0.2 | 150.00 | task notes --tail N to skim recent notes when spec is long |
| [`fb_wait_nextsteps_robust_no_commits`](tasks/fb_wait_nextsteps_robust_no_commits.md) | CLOSED | 60 | 0.2 | 300.00 | BUG: mu task wait --first nextSteps cherry-pick recipe silently picks wrong sha when worker closed without committing — surface 'no commits between fork and HEAD' explicitly |
| [`mu_adopt_should_be_mu_agent_adopt_for`](tasks/mu_adopt_should_be_mu_agent_adopt_for.md) | CLOSED | 8 | 0.2 | 40.00 | mu adopt should be mu agent adopt for consistency with the agent-namespace verb cluster |
| [`remove_top_level_mu_adopt_alias_now_was`](tasks/remove_top_level_mu_adopt_alias_now_was.md) | CLOSED | 8 | 0.1 | 80.00 | remove top-level mu adopt alias now (was deprecated in eaad4b7; nobody depends on it yet) |
| [`skill_cherry_pick_recipe_assumes_commit`](tasks/skill_cherry_pick_recipe_assumes_commit.md) | CLOSED | 12 | 0.2 | 60.00 | skill cherry-pick recipe assumes commit subject starts with task-id; workers don't |
| [`slugifytitle_silently_drops_clauses`](tasks/slugifytitle_silently_drops_clauses.md) | CLOSED | 15 | 0.3 | 50.00 | slugifyTitle silently drops clauses past 40 chars; truncated id can flip the meaning of a title |
| [`snapshot_gc_caps_too_lax_no_cleanup_verb`](tasks/snapshot_gc_caps_too_lax_no_cleanup_verb.md) | CLOSED | 35 | 0.5 | 70.00 | snapshot GC: AND-of-caps is too lax; no manual cleanup verb; defaults outgrow disk on busy days |
| [`task_add_slugify_silently_truncates_ids`](tasks/task_add_slugify_silently_truncates_ids.md) | CLOSED | 8 | 0.1 | 80.00 | task add slugify silently truncates ids; tail -N hides the warning |
| [`task_close_evidence_does_not_append_the`](tasks/task_close_evidence_does_not_append_the.md) | CLOSED | 10 | 0.2 | 50.00 | task close --evidence does not append the evidence as a final note |
| [`task_list_show_json_omits_localid_only`](tasks/task_list_show_json_omits_localid_only.md) | CLOSED | 25 | 0.3 | 83.33 | task list/show JSON omits localId; only top-level 'name' is exposed |
| [`task_show_blocked_by_renders_closed`](tasks/task_show_blocked_by_renders_closed.md) | CLOSED | 10 | 0.2 | 50.00 | task show 'blocked by' renders CLOSED blockers identically to OPEN ones |
| [`task_updatedat_not_bumped_by_reparent`](tasks/task_updatedat_not_bumped_by_reparent.md) | CLOSED | 20 | 0.3 | 66.67 | task.updatedAt not bumped by reparent / unblock / note (only by status change?) |
| [`task_wait_json_nextsteps_cherry_pick`](tasks/task_wait_json_nextsteps_cherry_pick.md) | CLOSED | 60 | 0.3 | 200.00 | task wait --json nextSteps cherry-pick verify command is JS-specific (npm run ...) |
| [`workers_commonly_attempt_unbounded_find`](tasks/workers_commonly_attempt_unbounded_find.md) | CLOSED | 25 | 0.3 | 83.33 | workers commonly attempt unbounded find / scans, costing >1h wall |
| [`workspace_orphans_misses_destroyed_workstreams`](tasks/workspace_orphans_misses_destroyed_workstreams.md) | CLOSED | 30 | 0.4 | 75.00 | mu workspace orphans misses dirs from destroyed workstreams |
| [`workstream_init_name_rejected_mu`](tasks/workstream_init_name_rejected_mu.md) | CLOSED | 10 | 0.1 | 100.00 | workstream init <name> rejected 'mu-feedback' silently (suggested 'feedback') |
