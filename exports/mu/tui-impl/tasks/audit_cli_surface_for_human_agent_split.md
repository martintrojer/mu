---
id: "audit_cli_surface_for_human_agent_split"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.4
roi: 162.50
owner: "worker-3"
created_at: "2026-05-12T12:48:02.500Z"
updated_at: "2026-05-12T15:46:36.395Z"
blocked_by: ["feat_mu_bare_launches_tui", "review_repo_agent_list_all_dead_surface"]
blocks: []
---

# AUDIT: review every CLI verb/flag through the human-uses-TUI / agent-uses-CLI lens — drop / collapse / rename anything that no longer earns its keep

## Notes (2)

### #1 by "π - mu", 2026-05-12T12:49:08.716Z

```
MOTIVATION (verbatim user)
--------------------------
\"this also means we can clean some of the verbs / flags perhaps. mission goes i think. so do an audit\"

CONTEXT — the human/agent split (per feat_mu_bare_launches_tui)
---------------------------------------------------------------
- bare 'mu' (TTY) = TUI — humans live here, yank commands out.
- typed verbs + --json = the agent's API.
- 'mu --help' (no TTY) = the agent reference.

Anything whose only consumer was the human looking at the OUTPUT of a static command is now redundant. The TUI shows it richer.

AUDIT — current TOP-LEVEL surface (mu --help)
----------------------------------------------
Verbs:
  agent      KEEP  agent CRUD; agents themselves use 'mu agent send' / 'mu agent read' / 'mu me'.
  archive    KEEP  cross-workstream preservation; both audiences use it.
  doctor     KEEP-AS-IS  diagnostic; humans see the Doctor card in TUI but the verb stays for CI/agent.
  log        KEEP  agent + human read; --tail is the streaming consumer.
  me         KEEP  in-pane agent self-identity. Can't be replaced by TUI (TUI is read-only).
  snapshot   KEEP  ops verb (list/show/prune/delete) + --undo. Diagnostic.
  sql        KEEP  escape hatch.
  state      SHRINK  see below.
  task       KEEP  task DAG ops; agents are the heaviest user.
  undo       KEEP  destructive recovery; one-shot human + agent.
  workspace  KEEP  per-agent VCS; both audiences use it.
  workstream KEEP  init/list/destroy/export/import; both audiences.

Flags on bare mu / mu state:
  -w, --workstream  KEEP  every verb that filters takes it.
  --json            KEEP  agent-only switch.
  --tui             SHRINK — see 'mu state --tui' below.

== mu state — the heaviest cleanup target ==

Today 'mu state' has FOUR rendering modes:
  1. (default static): full card. Human-facing — but TUI replaces this.
  2. --mission: stripped 5-column glance. Bare 'mu' is an alias today.
  3. --tui: launches the interactive TUI. Becomes bare 'mu' in v0.5.
  4. --json: JSON dump. Agent-facing — keep.

Plus:
  --all              sugar for 'every workstream'.
  --events <n>       how many recent events to include.
  -n, --lines <n>    alias for --events ('--hud muscle memory' — vestigial).

PROPOSED:

A. DROP --mission.
   - Bare 'mu' was the alias; bare 'mu' is now the TUI.
   - Mission card was the small-pane diagnostic for the orchestrator. The TUI's cards collectively cover the same data and more.
   - Agents that scripted 'mu state --mission --json': trivially migrate to 'mu state --json' (full snapshot is a superset).
   - Update CHANGELOG breaking-change note.

B. DROP --hud-era flags.
   - -n/--lines is documented as '--hud muscle memory'. --hud is gone (replaced by --tui in v0.4). Drop the alias; --events stays.
   - Also drop the comment fragment 'replaces the old --hud' from --tui's help.

C. CONSIDER DROPPING the static 'mu state' default render entirely.
   - Today 'mu state' (no flags) prints the full static card. Useful for:
     (a) Human reading from a non-TTY terminal: covered by 'mu' bare → help → 'pass --json or use mu' (the TUI).
     (b) Agent scripting: covered by --json.
     (c) CI / cron: covered by --json.
   - REMAINING USE CASE: human grep-pipe ('mu state | grep worker-1'). Quick + cheap; we'd lose this. Possibly worth keeping JUST the table-rendered shape behind --pretty or always-on-when-piped.
   - RECOMMEND: KEEP the static default for now. Re-evaluate in v0.6 once the bare-mu-launches-TUI flow is mature.

D. RENAME 'mu state' → 'mu snapshot view' or similar?
   - No. 'mu state' is the canonical name + heavy in muscle memory + matches docs/USAGE_GUIDE references everywhere.

E. KEEP --tui as an explicit override.
   - 'mu state --tui -w foo,bar' = TUI on a specific subset.
   - Bare 'mu' = TUI on ALL workstreams.
   - Both flows live. Backwards-compat for any existing 'mu state --tui' invocations.

== other audit findings ==

F. 'mu agent list --all' — DROP per review_repo_agent_list_all_dead_surface (already triaged + ready). Same lens applies.

G. 'mu --help' top-of-page text:
   - Today: program description + flat verb list.
   - PROPOSE: lead with 'Press 'mu' for the dashboard. Common verbs: mu task / mu agent / mu workspace.'
   - Then the full verb list.
   - When --json passed: terse one-line per verb (agent reference shape).
   - Skip if too invasive — cosmetic.

H. doctor / me / snapshot / sql / undo: leave alone. Pure diagnostic / one-shot verbs that humans + agents both use.

I. 'mu workspace' subcommands:
   - 'mu workspace path X' is heavily yanked from the TUI ('cd $(mu workspace path X)') — keep.
   - 'mu workspace list' is now duplicated by the Workspaces card. Both audiences still use it. Keep.
   - 'mu workspace orphans' is diagnostic only. Keep.

J. 'mu task next' / 'mu task list' / 'mu task tree':
   - All heavily used by agents (tasks workflow). Keep.
   - 'mu task tree' is now also covered by feat_tui_dag_popup (when shipped). Both stay.

K. 'mu archive show' / 'mu archive search':
   - Diagnostic + agent. Keep both. TUI doesn't yet have an Archives card; out of scope here.

L. 'mu log' / 'mu log --tail':
   - Agent + scripted use. Keep.
   - Human now uses TUI's Activity log card / popup → no need to grep 'mu log'.

== consolidated proposal ==

SHIP this slice (v0.5.0):
  1. Drop --mission flag from 'mu state'. Bare 'mu' becomes the TUI launcher (per feat_mu_bare_launches_tui).
  2. Drop -n/--lines alias from 'mu state' (--events stays).
  3. Drop --all from 'mu agent list' (covered by review_repo_agent_list_all_dead_surface).
  4. Update help text + docs + CHANGELOG to reflect the human/agent split.

DEFER:
  5. Dropping the static 'mu state' default render — keep until v0.6, watch for grep-pipe friction.
  6. 'mu --help' restructuring — cosmetic, wait for real friction.

ESTIMATED DIFF
--------------
- src/cli/state.ts: drop --mission branch, --lines alias, --hud comment fragments. ~50 LOC removed.
- src/cli/agents.ts: drop --all (also covered by sibling task).
- docs/USAGE_GUIDE.md: drop --mission section, update getting-started.
- docs/VOCABULARY.md: drop 'mission card' if listed.
- skills/mu/SKILL.md: drop --mission references.
- README.md: drop --mission references.
- CHANGELOG.md (under v0.5.0 BREAKING): list the dropped flags.
- test/state-render.test.ts + test/state-dispatch.test.ts: drop --mission cases.

CONSTRAINTS
-----------
- Conventional commit prefix: cli: (per change theme)
- Four greens before commit.
- Suggested commit (single):
    cli: drop --mission and --lines from 'mu state'; bare 'mu' is now the TUI launcher (humans live in TUI; --json stays for agents) — BREAKING

ORDERING
--------
This task lands in v0.5.0 — gate behind:
  - feat_mu_bare_launches_tui (the bare-mu→TUI shift this audit depends on)
  - all open v0.4.0 work
  - review_repo_agent_list_all_dead_surface (covers the --all drop)

Do NOT start until 'mu task tree audit_cli_surface_for_human_agent_split' shows all blockers CLOSED.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close audit_cli_surface_for_human_agent_split -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-12T15:46:36.395Z

```
CLOSE: 6313a4f: dropped mu state --mission and -n/--lines; verified agent list help has no --all and four greens passed
```
