---
id: "review_cli_destroy_archive_nextstep"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.1
roi: 800.00
owner: "worker-3"
created_at: "2026-05-13T12:38:45.360Z"
updated_at: "2026-05-13T12:45:23.805Z"
blocked_by: []
blocks: []
---

# REVIEW high: destroy dry-run Next drops --archive

## Notes (2)

### #1 by "worker-3", 2026-05-13T12:38:45.659Z

```
FILE(S):
  src/cli/workstream.ts:345-360

FINDING (complexity):
  if (opts.archive !== undefined) {
    console.log(
      `  archive      : ${pc.yellow(`would archive ${summary.taskCount} tasks to ${opts.archive}`)}`,
    );
  }
  ...
  printNextSteps([
    {
      intent: "Confirm and actually destroy",
      command: `mu workstream destroy -w ${workstream} --yes`,
    },

WHY IT'S A PROBLEM:
  The dry-run output tells the operator the confirmed run will archive the workstream, but the copy-paste Next command drops `--archive <label>`. Following the CLI's own next step destroys without preserving the graph in the named archive. This violates the self-documenting output/Next-step contract and can lose the exact preservation path the operator just previewed.

PROPOSED FIX:
  Build the confirm command once from the parsed options and reuse it in both JSON and human dry-run paths, including `--archive ${opts.archive}` when set (and consider preserving `--no-export` as well). Add/extend a CLI integration test for `mu workstream destroy -w ws --archive label` human dry-run that asserts the Next command includes `--archive label`, mirroring the existing JSON branch.

EFFORT NOTE:
  Small CLI-only patch. Seed a workstream + archive in a temp DB; no real tmux needed if the existing mocked tmux/runCli pattern is reused.
```

### #2 by "worker-3", 2026-05-13T12:45:23.805Z

```
CLOSE: 883c46e: dry-run Next now preserves --archive (and --no-export); test added
```
