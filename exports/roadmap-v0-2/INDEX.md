# roadmap-v0-2 — task index

| id | status | impact | effort | ROI | title |
| --- | --- | --- | --- | --- | --- |
| [`adopt_design`](tasks/adopt_design.md) | CLOSED | 60 | 0.3 | 200.00 | Design: mu adopt CLI shape, SDK shape, error cases |
| [`adopt_docs`](tasks/adopt_docs.md) | CLOSED | 50 | 0.1 | 500.00 | Docs: SKILL/USAGE_GUIDE/CHANGELOG entries for adopt |
| [`adopt_impl`](tasks/adopt_impl.md) | CLOSED | 60 | 0.5 | 120.00 | Impl: adoptAgent SDK + mu adopt verb + tests |
| [`bug_bare_mu_pane_lookup`](tasks/bug_bare_mu_pane_lookup.md) | CLOSED | 95 | 0.3 | 316.67 | BUG: bare `mu -w <ws>` errors 'can't find pane: 2' immediately after workstream init (no agents yet) |
| [`bug_claim_fk_external_agent`](tasks/bug_claim_fk_external_agent.md) | CLOSED | 70 | 0.2 | 350.00 | BUG: mu task claim fails with FK error when claimer agent isn't in the DB (cross-pi-session use) |
| [`bug_mu_sql_delete_no_confirm`](tasks/bug_mu_sql_delete_no_confirm.md) | CLOSED | 80 | 0.4 | 200.00 | BUG: mu sql DELETE silently deletes; needs --confirm-rows N or affected-row preview |
| [`bug_status_detector_pi_solo_misclassifies`](tasks/bug_status_detector_pi_solo_misclassifies.md) | CLOSED | 75 | 0.5 | 150.00 | BUG: status detector misclassifies pi-meta/--solo-wrapped agents as 'needs_input' while they're actively busy |
| [`bug_workstream_name_dot_mangle`](tasks/bug_workstream_name_dot_mangle.md) | CLOSED | 95 | 0.4 | 237.50 | BUG: workstream names containing '.' silently mangle in tmux ('roadmap-v0.2' -> session 'mu-roadmap-v0_2'); breaks every downstream command |
| [`code_review_pass_2`](tasks/code_review_pass_2.md) | CLOSED | 60 | 0.5 | 120.00 | REVIEW PASS 2: code-reviewer-1 audits src/ post-refactor + post-recent-shipped-fixes; file each finding as a mufeedback task |
| [`cross_workstream_claim_for`](tasks/cross_workstream_claim_for.md) | CLOSED | 60 | 0.3 | 200.00 | mu task claim --for <agent> succeeds when <agent> is in a different workstream than the task |
| [`hud_design`](tasks/hud_design.md) | CLOSED | 80 | 0.5 | 160.00 | Design: pi extension HUD — what to show, refresh strategy, screen real estate |
| [`hud_dogfood`](tasks/hud_dogfood.md) | CLOSED | 60 | 0.5 | 120.00 | Dogfood: run a real wave using mu hud + pane border, file friction |
| [`hud_extension_skeleton`](tasks/hud_extension_skeleton.md) | REJECTED | 60 | 0.5 | 120.00 | Impl: pi extension package skeleton (peer dep, SDK passthrough, doctor probe) |
| [`hud_visual_cue_design`](tasks/hud_visual_cue_design.md) | CLOSED | 70 | 0.3 | 233.33 | Design: visual cue 'you are looking at an agent' to prevent prompt-confusion |
| [`hud_visual_cue_impl`](tasks/hud_visual_cue_impl.md) | CLOSED | 70 | 0.5 | 140.00 | Impl: visual cue (status-line / pane-border / banner) + tests |
| [`hud_widget_impl`](tasks/hud_widget_impl.md) | REJECTED | 80 | 1.5 | 53.33 | Impl: HUD widget itself (mu state subscriber, render loop) |
| [`nit_agent_exists_error_clarity`](tasks/nit_agent_exists_error_clarity.md) | CLOSED | 50 | 0.1 | 500.00 | NIT: AgentExistsError message + hints don't make global-uniqueness obvious; jq hint is wrong |
| [`nit_blocks_flag_naming`](tasks/nit_blocks_flag_naming.md) | CLOSED | 30 | 0.2 | 150.00 | NIT: --blocks flag on task add is confusing (means 'blocked by', not 'blocks'); add --blocks-X mirror |
| [`nit_json_missing_roi`](tasks/nit_json_missing_roi.md) | CLOSED | 50 | 0.2 | 250.00 | BUG/NIT: mu task next --json (and probably others) emits roi=null instead of computed ROI |
| [`nit_long_auto_slug`](tasks/nit_long_auto_slug.md) | CLOSED | 35 | 0.2 | 175.00 | NIT: `mu task add --title <long>` produces 60+ char auto-IDs that are awkward to type; consider word-boundary trim at ~40 chars |
| [`nit_no_mu_task_wait`](tasks/nit_no_mu_task_wait.md) | CLOSED | 75 | 0.4 | 187.50 | NIT: orchestrator hand-rolls polling loops because mu has no 'wait for tasks to reach status X' primitive |
| [`nit_no_workstream_rename`](tasks/nit_no_workstream_rename.md) | CLOSED | 45 | 0.4 | 112.50 | NIT: no `mu workstream rename <old> <new>` verb; forces hand-written SQL migration |
| [`nit_sql_multi_statement`](tasks/nit_sql_multi_statement.md) | CLOSED | 40 | 0.2 | 200.00 | NIT: `mu sql` rejects multi-statement scripts; forces N invocations for migrations |
| [`nit_table_no_truncation`](tasks/nit_table_no_truncation.md) | CLOSED | 50 | 0.3 | 166.67 | NIT: mu task ready/goals/list don't truncate the title column; rows balloon to 200+ chars |
| [`nit_task_list_status_filter`](tasks/nit_task_list_status_filter.md) | CLOSED | 35 | 0.15 | 233.33 | NIT: `mu task list` has no --status filter; can't easily ask 'show me only OPEN tasks' |
| [`nit_workstream_name_mu_prefix`](tasks/nit_workstream_name_mu_prefix.md) | CLOSED | 25 | 0.1 | 250.00 | NIT: `mu workstream init mu-X` produces tmux session `mu-mu-X` (double prefix); doc the convention or strip |
| [`pass_mu_env_to_panes`](tasks/pass_mu_env_to_panes.md) | CLOSED | 70 | 0.4 | 175.00 | Pass MU_MANAGED_AGENT / MU_AGENT_NAME / MU_WORKSTREAM env vars to mu-spawned tmux panes |
| [`polish_roadmap_section_for_bugs_nits_without_promotion_criteria`](tasks/polish_roadmap_section_for_bugs_nits_without_promotion_criteria.md) | CLOSED | 30 | 0.1 | 300.00 | Polish: roadmap section for bugs/nits without promotion criteria |
| [`roadmap_rename_next_possible`](tasks/roadmap_rename_next_possible.md) | CLOSED | 30 | 0.05 | 600.00 | Roadmap rename: Next -> Possible |
| [`selfdoc_design`](tasks/selfdoc_design.md) | CLOSED | 80 | 0.3 | 266.67 | Design: self-documenting verb output (next-step hints + structured JSON) |
| [`selfdoc_dogfood`](tasks/selfdoc_dogfood.md) | CLOSED | 60 | 0.3 | 200.00 | Dogfood: use mu in a real session post-rollout; tune signal/noise of next-step hints |
| [`selfdoc_errors`](tasks/selfdoc_errors.md) | CLOSED | 60 | 0.4 | 150.00 | Impl: typed errors gain actionable nextSteps (every error class) |
| [`selfdoc_infra`](tasks/selfdoc_infra.md) | CLOSED | 80 | 0.7 | 114.29 | Impl: nextSteps infrastructure + JSON error shape + first batch of verbs |
| [`selfdoc_json_universal`](tasks/selfdoc_json_universal.md) | CLOSED | 70 | 0.4 | 175.00 | Impl: --json works on every mu verb (write + read) |
| [`selfdoc_skill_cleanup`](tasks/selfdoc_skill_cleanup.md) | CLOSED | 70 | 0.5 | 140.00 | Docs: trim SKILL.md (~770 -> ~500 LOC) + USAGE_GUIDE; per-verb tips move into verb output |
| [`selfdoc_verbs_round2`](tasks/selfdoc_verbs_round2.md) | CLOSED | 50 | 0.6 | 83.33 | Impl: nextSteps hints for the rest of the verbs (per audit table) |
| [`snap_design`](tasks/snap_design.md) | CLOSED | 90 | 0.7 | 128.57 | Design: snapshots — capture strategy, undo-graph, edge cases (cross-workstream, FK CASCADE, recovery) |
| [`snap_destroy_safety`](tasks/snap_destroy_safety.md) | CLOSED | 80 | 0.4 | 200.00 | Impl: mu workstream destroy --yes loses irreversibility — pre-snapshot or block undo across destroy |
| [`snap_docs`](tasks/snap_docs.md) | CLOSED | 50 | 0.2 | 250.00 | Docs: snapshots in CHANGELOG + ROADMAP move to shipped + SKILL undo pattern |
| [`snap_dogfood`](tasks/snap_dogfood.md) | CLOSED | 70 | 0.3 | 233.33 | Dogfood: deliberately break things and recover |
| [`snap_schema`](tasks/snap_schema.md) | CLOSED | 80 | 0.5 | 160.00 | Impl: snapshots table + auto-snapshot hook in writer ops |
| [`snap_undo_reconcile_destroys_recovered_agents`](tasks/snap_undo_reconcile_destroys_recovered_agents.md) | CLOSED | 85 | 0.5 | 170.00 | mu undo + workstream-destroy: reconcile prunes the recovered agent row + cascades vcs_workspaces away |
| [`snap_undo_verb`](tasks/snap_undo_verb.md) | CLOSED | 90 | 0.8 | 112.50 | Impl: mu undo / mu redo / mu snapshot list verbs + tests |
| [`test_review_pass_2`](tasks/test_review_pass_2.md) | CLOSED | 60 | 0.5 | 120.00 | REVIEW PASS 2: test-reviewer-1 audits test/ post-refactor + post-recent-shipped-fixes; file each finding as a mufeedback task |
| [`workspace_create_partial_dir_on_failure`](tasks/workspace_create_partial_dir_on_failure.md) | CLOSED | 60 | 0.5 | 120.00 | mu workspace create can leave partial on-disk dir if interrupted; none-backend cp -a from $HOME is a footgun |
