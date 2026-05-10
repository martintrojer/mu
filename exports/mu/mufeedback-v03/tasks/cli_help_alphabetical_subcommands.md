---
id: "cli_help_alphabetical_subcommands"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-10T06:57:56.796Z"
updated_at: "2026-05-10T07:02:48.763Z"
blocked_by: []
blocks: []
---

# polish: sort --help command/option lists alphabetically (top-level + every subcommand group)

## Notes (1)

### #1 by π - mu, 2026-05-10T06:58:30.531Z

```
Sort `--help` Commands list alphabetically.

═══ THE FRICTION ═══

Today's `mu --help` shows top-level commands in REGISTRATION ORDER (workstream, archive, agent, adopt, me, workspace, task, log, approve, state, hud, sql, undo, snapshot, doctor). The order is:
  - Inscrutable to operators ("why does archive come before agent?")
  - Drift-prone (every new verb risks shifting the listing)
  - Inconsistent across subcommand groups (each group has its own ad-hoc registration order)

Same friction at every subcommand level: `mu task --help` lists add / list / next / owned-by / note / show / tree / notes / close / open / reject / defer / release / claim / block / unblock / update / reparent / wait / delete in registration order.

Operators read help looking for one verb; alphabetical listing makes it grep-able. mu's docs (USAGE_GUIDE, SKILL) already group by namespace; the --help should mirror by sorting within each group.

═══ THE SCOPE ═══

Sort the COMMANDS LIST (not the options list) alphabetically in:

  1. Top-level `mu --help` Commands list.
  2. Every subcommand group's --help Commands list:
     - mu workstream --help
     - mu archive --help
     - mu agent --help
     - mu workspace --help
     - mu task --help
     - mu approve --help
     - mu snapshot --help
     - mu me --help (only 2 subcommands; trivial)
  3. Subcommand groups under groups (none today; future-proof against drift).

DO NOT sort:
  - The Options list under each command. Options have a conventional order (-h/--help last; positional flags first; short-form -X aliases stay grouped with their long form). Re-ordering would break operator muscle memory.
  - Positional arguments. Their order is part of the verb signature.
  - The "Next:" hint blocks each verb prints on success. Those are content-curated by the verb author; not subject to the alphabetical rule.

═══ THE COMMANDER MECHANICS ═══

Commander.js exposes the commands list via .commands; sort order is determined by registration order. Commander v11+ supports two ways:
  A. .configureHelp({ sortSubcommands: true }) — flag on each command. Inherited by subcommands? CHECK behaviour; if not inherited, set on every group.
  B. .helpInformation() override — manual help renderer. More invasive; reject unless A doesn't suffice.

Recommend A. One line per command group:
  program.configureHelp({ sortSubcommands: true });
  // Commander 11+ inherits configureHelp to subcommands by default; verify in the test.

ALTERNATIVE: a single helper `applyAlphabeticalHelpSort(cmd)` that recursively walks .commands and sets sortSubcommands on each. Wins on certainty (no version-dependent inheritance behaviour); 5 LOC.

═══ THE TEST ═══

test/cli-help-sorted.test.ts (NEW, ~80 LOC):
  1. Run `mu --help`; parse the Commands block; assert alphabetical.
  2. For each subcommand group, run `mu <group> --help`; parse; assert alphabetical.
  3. For each known command (mu task add, mu agent spawn, etc.) `mu <group> <cmd> --help` works (sort doesn't break anything).
  4. Spot-check that the Options list ORDER is preserved (not alphabetical) for one command (e.g., `mu task add --help` should still have `--title` first, `-h, --help` last).

═══ FILES ═══

  src/cli.ts           : 1-2 LOC: configureHelp on the root program (plus the recursive helper if needed).
  src/cli/agents.ts    : maybe 1 LOC if subcommand groups need their own configureHelp.
  src/cli/archive.ts   : same.
  src/cli/workstream.ts: same.
  src/cli/workspace.ts : same.
  src/cli/tasks/wire.ts: same.
  src/cli/approve.ts   : same.
  src/cli/snapshot.ts  : same.
  test/cli-help-sorted.test.ts: NEW.
  CHANGELOG.md         : 1-line v0.3 entry.

ESTIMATE: ~30 LOC of code + ~80 LOC of tests. Trivial.

═══ ANTI-FEATURES ═══

  - Don't add a config knob ("sort or don't"). Alphabetical, always.
  - Don't sort options. They're authored in semantic order; alphabetical would be worse for readability.
  - Don't add a custom collator. Default localeCompare/unicode is fine for ASCII verb names.

═══ PROMOTION ═══

  - Real-user friction: filed by operator after seeing `mu --help` Commands list during v0.3 wave. ≥1 hit; the listing's confusion-cost is permanent (every help invocation pays it).
  - Substrate: commander built-in. Trivial.
  - Fits in <300 LOC: yes (~30).

PROMOTE for v0.3. Lives in mufeedback-v03 (CLI surface polish).

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close cli_help_alphabetical_subcommands -w mufeedback-v03 --evidence 'configureHelp sortSubcommands wired; test asserts alphabetical at every subcommand level'
```
