---
id: "cli_audit_plurality_uniformity"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: null
created_at: "2026-05-10T05:34:28.362Z"
updated_at: "2026-05-10T05:44:03.906Z"
blocked_by: []
blocks: ["hud_multi_workstream"]
---

# audit: CLI plurality — repeat-flag vs comma-list vs variadic-positional; pick ONE convention; fix divergences

## Notes (2)

### #1 by "π - mu", 2026-05-10T05:35:24.802Z

```
CLI plurality — pick one convention, fix divergences.

═══ THE FRICTION ═══

mu's CLI today has THREE mechanisms for "this flag/positional accepts >1 value":

  1. CSV-via-single-flag:        --blocked-by a,b,c      (task add, task reparent)
  2. Variadic positional:        mu task wait a b c      (task wait)
  3. Repeated flag (PROPOSED):   -W X -W Y -W Z          (filed in hud_multi_workstream as one of three options)

Plus single-valued today, plurality requested:
  - mu hud -w X (single, with auto-resolution chain) → operator wants multi-workstream HUD (filed as hud_multi_workstream).

This audit's job: pick ONE convention, document it, fix divergences. The hud filing should not land in a third shape; it should follow whatever this audit picks.

═══ THE THREE OPTIONS ═══

A. CSV-via-single-flag      `--ids a,b,c` / `--workstreams X,Y`
B. Repeated flag            `--id a --id b --id c` / `-W X -W Y`
C. Variadic positional      `mu task wait a b c` (only when the flag IS the positional)

═══ TRADE-OFF MATRIX ═══

  CSV
    + 1 flag, short to type for small lists.
    + Existing pattern (--blocked-by) — back-compat is free.
    - Doesn't compose with values containing commas (none in mu today, but a future FK or evidence string might).
    - Two-step parse (split + trim + filter) duplicated at every call site.
    - Shell-history search for `--blocked-by foo` doesn't find `--blocked-by foo,bar`.

  Repeated flag (commander's `--id <id...>` variadic flag)
    + Composes with any value (including commas).
    + One-flag-one-value is grep-able in shell history.
    + Each `-w X -w Y` repetition reads explicitly.
    - More keystrokes for a 5-element list.
    - Can confuse beginners (looks redundant).
    - Commander variadic-flag interaction with global -w (per AGENTS.md gotcha) needs careful test.

  Variadic positional
    + Shortest possible: `mu task wait a b c`.
    + Read like a Unix tool (cat a b c, grep -l pat a b c).
    - Only works when the multi-value is THE main argument (one positional list per command).
    - Won't fit hud's case (-w / -W is a filter, not the operand).
    - Can't combine multiple variadics in one command.

═══ CURRENT STATE — INVENTORY ═══

  Multi-value via CSV:
    src/cli/tasks/wire.ts:42      task add --blocked-by a,b,c
    src/cli/tasks/wire.ts:389     task reparent --blocked-by a,b,c
    (parse: src/cli/tasks/edges.ts:81, src/cli/tasks/edit.ts:105 — duplicated split-trim-filter)

  Multi-value via variadic positional:
    src/cli/tasks/wire.ts (task wait)  mu task wait a b c

  Multi-value via repeated flag:
    NONE today.

  Multi-value PROPOSED but undecided:
    hud_multi_workstream (mufeedback-v03 task)  -W X,Y vs -W X -W Y vs --workstreams X,Y vs --all

  Implicit single-but-could-be-multi (unclear if friction exists yet):
    -w on every verb (single by design; resolution chain handles ambiguity)
    --blocked-by has --by single-valued mirror in `task block`
    --status on `task wait` is single (any-of-N would be a future filing)

═══ THE RECOMMENDATION ═══

  PICK COMMA-SEPARATED (option A) AS THE SINGULAR CONVENTION.

Reasoning:

  1. We already have it in two places (`--blocked-by`). Picking it makes those callsites the canonical example, not the divergence to fix.
  2. Variadic positional (option C) is a SUBSET of "the operation takes a list" and only applies when the list IS the only operand. Keep `task wait <ids...>` as it is; it's the right shape for that specific verb. NOT a divergence — the audit explicitly carves it out as "single-positional-list verbs".
  3. Repeated flag (option B) wins on shell-history grep but loses on terseness. mu's CLI bias is terse + uniform; CSV is shorter for the common 2–3-element cases.
  4. The complaint about commas-in-values: mu's identifiers (workstream names, task local_ids, agent names, archive labels) use the same `[a-z][a-z0-9_-]+` charset everywhere. Commas are LEXICALLY excluded from valid identifiers. The risk is theoretical only.
  5. CSV unifies with how operators already write things in mu sql (`name IN ('a','b','c')`) and in shell (`tmux list-panes -F '#S,#W'`).

  Carve-outs (NOT divergences from the rule):
    - `mu task wait a b c` — variadic positional. The operands ARE the list, no flag involved. This is the same pattern as `cat a b c`, `grep pat a b c`. Keep.
    - `-w` (workstream) STAYS single-valued on every verb except hud. mu's per-verb workstream scope is a load-bearing invariant (FK CASCADE shape, etc.). hud is the one read-only multi-tenant verb where -W (or whatever flag we pick) makes sense.

  For hud (the live filing): use CSV via a NEW flag named `--workstreams` (long form only, NOT `-W`). The mufeedback-v03 hud task should be amended with that decision. Reasoning: -w stays single-valued (back-compat); --workstreams is the multi-valued companion; both share the same CSV grammar. Add `--all` as the "every workstream" sugar (no value to parse).

═══ DELIVERABLES ═══

  1. Document the convention in docs/USAGE_GUIDE.md (one short paragraph in a "CLI conventions" section if not present, else add to it):
     "Multi-value flags use comma-separated form (`--blocked-by a,b,c`). Single-positional-list verbs use variadic positionals (`mu task wait a b c`). Repeated flags (`--id a --id b`) are NOT used."
  2. Extract the duplicated `split(',').map(trim).filter(Boolean)` into a single helper in src/cli.ts (or src/cli/_shared.ts). Use it from src/cli/tasks/edges.ts and src/cli/tasks/edit.ts. Name: `parseCsvFlag(value: string): string[]`.
  3. Document the CSV decision on hud_multi_workstream task as an addendum (so the worker landing hud knows which option to pick).
  4. CHANGELOG.md (v0.3 unreleased): one-line "CLI plurality convention codified: CSV for multi-value flags; variadic positional only when the list IS the operand."
  5. NO new verbs touched. NO existing flag renamed. The audit only EXTRACTS the helper + DOCUMENTS the rule.

═══ EXPLICIT NON-CHANGES ═══

  - Do NOT migrate `task wait <ids...>` to CSV. Variadic positional is the right shape there (carve-out documented).
  - Do NOT change the help text on `--blocked-by` (today's "comma-separated task ids ..." is already canonical).
  - Do NOT add the `--workstreams` flag to any verb other than hud. This audit codifies the CONVENTION; it does not gain plurality on verbs that aren't asking for it.

═══ PROMOTION ═══

  - Real-user friction: a third plurality shape (-W X -W Y) was about to land in hud_multi_workstream because no convention was codified. Deciding now prevents permanent divergence. ≥2 hits (the existing CSV/variadic split + the imminent hud filing).
  - Substrate: a 5-line helper + a docs paragraph + a one-line CHANGELOG entry + a note-addendum on hud. Trivial.
  - Fits in <300 LOC: trivially (~30 LOC code change including the test).

PROMOTE for v0.3. Lives in mufeedback-v03 (codification of CLI surface; not a planned feature). Should land BEFORE hud_multi_workstream so the hud worker reads the convention from the docs/note and follows it.

═══ DEPENDENCIES ═══

  Blocks: hud_multi_workstream (so the hud worker doesn't pick a third shape).

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close cli_audit_plurality_uniformity -w mufeedback-v03 --evidence 'helper extracted; convention documented; hud task amended'
```

### #2 by "π - mu", 2026-05-10T05:36:06.909Z

```
ADDENDUM (operator): better convention — accept BOTH repeated-flag AND comma-separated, uniformly. Operators get to pick whichever ergonomics fit the moment; the parser canonicalises.

═══ THE REVISED CONVENTION ═══

Every multi-value flag in mu accepts EITHER:
  --ids a,b,c                    (CSV)
  --ids a --ids b --ids c        (repeated flag)
  --ids a,b --ids c              (mixed)

All three collapse to the same `string[]` after parsing. No mode flag. No "pick one." The parser doesn't care.

═══ THE COMMANDER MECHANICS ═══

Two pieces:

  1. Declare every multi-value option as VARIADIC:
       .option("-b, --blocked-by <ids...>", "task ids that block this one (repeat or comma-separate; or both)")
     Commander gives back string[] for repeated invocations. Default is [].

  2. Post-process each element through CSV split + trim + filter (one helper):
       export function parseCsvFlag(values: readonly string[] | undefined): string[] {
         if (!values) return [];
         return values.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));
       }
     Idempotent. `--ids a,b` → ["a,b"] → ["a", "b"]. `--ids a --ids b` → ["a", "b"] → ["a", "b"]. `--ids a,b --ids c` → ["a,b", "c"] → ["a", "b", "c"].

  Single helper used everywhere. NO duplication. NO per-callsite split.

═══ HELP TEXT CONVENTION ═══

Every multi-value flag's help text uses the SAME stock phrase:

  "(repeat or comma-separate; or both)"

So operators learn the pattern once and recognise it everywhere. Example:

  -b, --blocked-by <ids...>     task ids that block this one (repeat or comma-separate; or both)
  --workstreams <names...>      workstreams to include (repeat or comma-separate; or both)

The `<ids...>` triple-dot in the metavar IS the syntactic signal that the flag is variadic; the parenthetical reinforces it for help readers.

═══ REVISED DELIVERABLES ═══

  1. New helper `parseCsvFlag(values: readonly string[] | undefined): string[]` in src/cli/_shared.ts (NEW file) or src/cli.ts (whichever the existing cluster prefers — mirror existing helpers).

  2. Migrate the existing two CSV callsites:
     - src/cli/tasks/wire.ts:42 — `--blocked-by <ids>` becomes `--blocked-by <ids...>`; help text becomes the stock phrase. The cmdTaskAdd handler reads `opts.blockedBy` (which commander now gives as string[]) and passes through parseCsvFlag.
     - src/cli/tasks/wire.ts:389 — `--blocked-by` on task reparent: same migration. The cmdTaskReparent split logic in src/cli/tasks/edges.ts:81 deletes; replaced by parseCsvFlag(opts.blockedBy).
     - The bare-string `task add --blocked-by foo,bar` continues to work (commander variadic accepts a single value too — coerces to ['foo,bar'] → parseCsvFlag → ['foo','bar']).

  3. test/cli-shared.test.ts (NEW, ~50 LOC): exhaustive parseCsvFlag matrix:
     - undefined → []
     - [] → []
     - ['a'] → ['a']
     - ['a,b,c'] → ['a','b','c']
     - ['a','b','c'] → ['a','b','c']
     - ['a,b','c'] → ['a','b','c']
     - ['  a , b ', 'c , d '] → ['a','b','c','d']
     - ['a,,b'] → ['a','b']  (empty between commas dropped)
     - ['a,', '', ',b'] → ['a','b']
     The trim-and-filter guards make the helper invariant under whitespace + empty fragments.

  4. Migrate existing tests for task add / task reparent to assert the new shapes work AND today's CSV string still works.

  5. docs/USAGE_GUIDE.md: short "CLI conventions" subsection (or extend if present):
     "Multi-value flags accept either repeat (`--ids a --ids b`) or comma-separated (`--ids a,b`) or both (`--ids a,b --ids c`). Look for `<value...>` in the metavar — that's the signal."

  6. CHANGELOG.md (v0.3 unreleased): one line —
     "CLI multi-value flags now accept repeat OR comma-separated forms uniformly (today's `--blocked-by a,b,c` keeps working; you can now also `--blocked-by a --blocked-by b`)."

  7. AMEND hud_multi_workstream task with this convention so the hud worker uses `--workstreams <names...>` (variadic + parseCsvFlag) and gets the dual-form for free.

═══ WHAT STAYS THE SAME ═══

  - `mu task wait a b c` keeps its variadic positional shape. Variadic positionals already collapse repeats naturally; no parseCsvFlag needed (and no comma syntax — operands separated by spaces follow Unix convention, not CSV).
  - Single-value flags (-w, --by, --status, --title, etc.) STAY single. The convention only applies to flags with `<value...>` in their metavar.
  - `mu hud -w X` — single-valued `-w` keeps its existing resolution chain. The new `--workstreams <names...>` is the multi companion.

═══ WHY THIS IS BETTER THAN "PICK ONE" ═══

  - Zero ergonomics regression: today's `--blocked-by foo,bar,baz` keeps working byte-for-byte.
  - New ergonomics for free: shell history search, value-with-comma future-proofing, easier scripting (loop-and-append a flag).
  - One helper, one help text phrase, one mental model. Uniformity preserved.
  - No flag ever has "pick the right form" friction. Operator types whichever; mu canonicalises.

═══ REVISED PROMOTION ═══

Same scope (~50 LOC code + helper + tests + docs), strictly more permissive UX. Land before hud_multi_workstream so the hud worker uses the new pattern.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close cli_audit_plurality_uniformity -w mufeedback-v03 --evidence 'parseCsvFlag helper + dual-form on existing flags + tests + docs + hud task amended'
```
