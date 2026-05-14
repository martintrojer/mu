---
id: "feat_mu_bare_launches_tui"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.3
roi: 250.00
owner: "worker-2"
created_at: "2026-05-12T12:46:19.875Z"
updated_at: "2026-05-12T15:06:26.996Z"
blocked_by: ["bug_tui_card_body_collapses_into_bottom_border", "feat_tui_dag_popup", "review_repo_agent_list_all_dead_surface", "review_repo_archive_events_not_incremental", "review_repo_export_bucket_index_not_additive", "review_repo_git_dirty_check_dup", "review_repo_hud_residue_dead_helpers", "review_repo_process_exit_inside_handlers", "review_repo_unused_zod_dependency", "review_repo_workspace_commits_json_loses_metadata", "testreview_acceptance_bypasses_lifecycle", "testreview_env_leak_no_color", "testreview_fixed_sleep_flakes", "testreview_json_shape_weak_assertions", "testreview_static_source_assertions"]
blocks: ["audit_cli_surface_for_human_agent_split", "feat_claim_warn_stale_workspace", "feat_tui_commits_card"]
---

# FEAT: bare 'mu' launches the TUI with all workstreams when TTY-attached; prints --help otherwise — TUI becomes the human's default front door

## Notes (2)

### #1 by "π - mu", 2026-05-12T12:47:01.868Z

```
MOTIVATION (verbatim user)
--------------------------
\"the tui is becoming the main human interface for mu, and the cli is the agents interface. can we lean into this and come up with ideas how to streamline the cli interface and making it easier to launch the tui.\"

\"if mu bare launched the tui if we are in a TTY with all workstreams 'selected' that might be a reasonable default. and just mu --help if bare in non-tty.\"

ARCHITECTURAL FRAMING
---------------------
TUI = human's home base (yank-and-run model).
CLI verbs = agent's API (--json-first, scripted by 'mu task wait | jq').

Today both audiences collide on bare 'mu': humans get a static state card + Next: block (designed for agents) instead of the rich TUI they actually use. This task makes 'mu' the one-shot front door for humans without changing any verb surface for agents.

DECISION TABLE (per orchestrator triage with the user)
------------------------------------------------------
A. Bare 'mu' default in TTY: launch TUI immediately with ALL workstreams loaded. Skip the static card entirely.
B. Bare 'mu' in non-TTY (piped, scripted, redirected): print 'mu --help'. Today prints the static state card; that's noisier than help when the consumer is 'mu | grep'.
C. mu state --tui keeps working for explicit selection (back-compat).
D. mu state (no --tui) still prints the static card (back-compat for any agent scripts).
E. All verbs unchanged. No agent-surface migration.

IMPLEMENTATION SKETCH
---------------------
1. src/cli.ts buildProgram bare-action handler:
   - Detect TTY: process.stdout.isTTY === true.
   - Detect MU_NO_TUI env: short-circuit to non-TTY behaviour.
   - Detect --json / -h / --help: short-circuit to current behaviour.
   - If TTY + not opt-out:
       - Load all workstreams via listWorkstreams(db).
       - If 0 workstreams: print 'mu --help' + a 'Get started: mu workstream init <name>' Next: hint. Exit 0.
       - If >=1 workstream:
           - Resolve initial active tab: prefer $MU_SESSION when set + valid; else workstreams[0].
           - Lazy-import ./cli/tui/index.js (current pattern from cmdState --tui).
           - runTui({ db, workstreams: workstreams.map(w => w.name), initialActive }).
   - If non-TTY: behave as 'mu --help' today (commander already wires this when given no command + the program help text).

2. src/cli/tui/index.ts runTui signature:
   - Today: { db, workstreams: string[] }. The App constructor already takes 'workstreams' + tracks 'activeWs' (defaults to 0).
   - Add optional 'initialActive?: number' to runTui + thread it into <App initialActive={...}>. App's useState<number>(initialActive ?? 0).
   - Bounds-clamp at App level (already done defensively).

3. Tests:
   - test/cli-bare-launches-tui.test.ts (new): mock runTui + listWorkstreams. Assert:
     a. TTY + workstreams=[A,B,C] + $MU_SESSION=B → runTui called with workstreams=[A,B,C], initialActive=1.
     b. TTY + workstreams=[] → runTui NOT called; help printed.
     c. Non-TTY + workstreams=[A] → runTui NOT called; help printed.
     d. MU_NO_TUI=1 + TTY → runTui NOT called.
     e. --json passed → bare action does NOT trigger (commander default).
   - Update test/state-dispatch.test.ts and any other test that assumed 'bare mu' equals 'mu state --mission'.

4. Docs:
   - README.md: lead with 'mu' (bare) → TUI; mention --json + MU_NO_TUI for scripted use.
   - docs/USAGE_GUIDE.md: rewrite the 'getting started' opening — bare 'mu' is the first step now.
   - skills/mu/SKILL.md: mention that agents (which run as scripts, not TTY) see the help / JSON path; humans see the TUI.
   - CHANGELOG.md (under v0.5.0 features): bullet under 'TUI / human interface'.

5. ARCHITECTURE.md: add a short section codifying the dual-audience contract:
   - Human entrypoint: bare 'mu' → TUI.
   - Agent entrypoint: typed verbs + --json. Agents read from $MU_PI_COMMAND etc.
   - The split is enforced by stdout-is-TTY and MU_NO_TUI, not by namespace.

EDGE CASES
----------
- $MU_SESSION points at a workstream that no longer exists: fall back to workstreams[0]. Already-existing TUI bounds-clamp covers this.
- Stdout is a TTY but stdin is a pipe (rare): still launch TUI. The TUI reads from stdin via ink for keystrokes; if stdin is also non-TTY, ink raises its own error which we should catch and degrade to the help path.
- 'mu' invoked from a tmux pane managed by mu itself (the orchestrator): launches the TUI showing every workstream including the orchestrator's own. Fine — read-only TUI is safe.
- 'mu' inside a CI: stdout is non-TTY by default, prints help. No surprise.

OUT OF SCOPE
------------
- Don't drop or rename 'mu state'. Keep it for back-compat.
- Don't add a config file (anti-feature pledge).
- Don't add 'mu open <ws-or-task>' (separate task if asked — bare 'mu' covers the headline use case).
- Don't promote a 'human-vs-agent' env split (MU_HUMAN / MU_AGENT) — TTY detection is the natural seam.
- Don't rewrite 'mu --help' to be 'human-first' here (separate task if asked — keep agent help intact).
- Don't add a TUI command palette (separate task; v0.5+).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Conventional commit prefix: tui: or cli:
- Four greens before commit.
- Suggested commit:
    cli: bare 'mu' launches TUI with all workstreams when TTY-attached (humans' new default front door; non-TTY prints help)

⚠️ ORDERING ⚠️
This task lands in v0.5.0 — gate behind all open v0.4.0 work via task block edges. Do NOT start until the v0.4.0 review wave is done and v0.4.0 is tagged.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_mu_bare_launches_tui -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-2", 2026-05-12T15:06:26.996Z

```
CLOSE: d65f388: bare mu now TTY-launches all-workstream TUI; non-TTY/help paths preserved; four greens + smoke passed
```
