---
id: "verb_arg_qualified_workstream_name"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.5
roi: 60.00
owner: "worker-mf-2"
created_at: "2026-05-09T13:22:45.827Z"
updated_at: "2026-05-09T14:20:46.269Z"
blocked_by: ["output_id_vs_name_audit"]
blocks: []
---

# verbs accept <workstream>/<name> qualified entity refs (Phase 3 of OUTPUT_LABELS_AUDIT — parse-at-CLI-entry helper, ~50 LOC + tests)

## Notes (1)

### #1 by worker-mf-2, 2026-05-09T13:23:36.557Z

```
PHASE 3 of OUTPUT_LABELS_AUDIT. Orthogonal to the JSON/label rename — can ship before, with, or after.

═══ SCOPE ═══

Every verb that takes a task / agent / approval entity-name argument accepts EITHER:
  - bare `<name>` → resolves via current workstream context (today)
  - qualified `<workstream>/<name>` → no -w needed; resolves directly

Affected verbs (per audit per-verb matrix):
  task: show / tree / notes / note / close / open / reject / defer / release / claim / block / unblock / delete / update / reparent / wait
  agent: send / read / show / close / free / attach / adopt
  workspace: create / free / path
  approve: grant / deny / wait

═══ IMPLEMENTATION SHAPE ═══

  // src/cli.ts (or new helpers file)
  export function parseQualifiedRef(raw: string): { workstream?: string; name: string } {
    const slashIdx = raw.indexOf("/");
    if (slashIdx === -1) return { name: raw };
    return { workstream: raw.slice(0, slashIdx), name: raw.slice(slashIdx + 1) };
  }

  // wired at every cli/* entry that takes an entity arg:
  const { workstream: qws, name: localId } = parseQualifiedRef(rawArg);
  const ws = qws ?? await resolveWorkstream(opts.workstream);

═══ ERROR MAPPING ═══

  - Qualified form references missing workstream → WorkstreamNotFoundError → exit 3 (already mapped post-schema_v5_cli_boundary)
  - Qualified form references missing name in real workstream → existing TaskNotFoundError / AgentNotFoundError → exit 3

═══ EDGE CASES ═══

  - Names containing "/" forbidden? Today the validator (workstream.ts WorkstreamNameInvalidError, slugify in tasks.ts) already restricts to a safe charset. Confirm no entity-name shape allows "/".
  - --workstream + qualified ref together → conflict. Throw UsageError or let qualified silently win? Spec: throw UsageError with clear message.
  - The orchestrator anti-feature: no surrogate INTEGER ids on the CLI EVER (still applies).

═══ TESTS ═══

  Unit: parseQualifiedRef happy-path + edge cases (multiple slashes, leading/trailing).
  Integration: smoke `mu task show <wsA>/foo` from a -w wsB context, expect wsA/foo.

═══ CHANGELOG ═══

[Unreleased] / Added (the qualified-form is additive; bare-form unchanged). Help text WILL change `<id>` → `<name>` across every entity-arg verb in the same commit, which is a Breaking blurb if any external script greps `--help` output (audit recommends folding it in).

═══ EFFORT ═══

~50 LOC parser + ~50 LOC wiring across affected verbs + ~50 LOC tests = ~150 LOC. Audit estimate was 0.5d.
```
