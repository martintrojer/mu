---
id: "output_id_vs_name_audit"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: null
created_at: "2026-05-09T13:04:43.531Z"
updated_at: "2026-05-09T13:24:03.309Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone", "output_json_keys_rename_v5", "output_labels_human_rename", "verb_arg_qualified_workstream_name"]
---

# audit: cli output uses 'id' for what is conceptually a 'name' post-v5; align labels + support qualified <workstream>/<name> refs

## Notes (2)

### #1 by "π - mu", 2026-05-09T13:05:36.307Z

```
SURFACED LIVE post-schema-v5: the CLI's column headers and JSON keys still call the operator-facing identifier "id" / "localId" everywhere, but post-v5 those are NAMES (per-workstream-unique strings the operator chose), distinct from the internal surrogate INTEGER `id` that lives in the DB and never escapes to the operator.

═══ THE LABEL DRIFT ═══

v4 model: tasks.local_id was the PK and the operator's reference. "id" was correct.
v5 model: tasks.id (INTEGER) is the PK; tasks.local_id (TEXT) is the operator-facing NAME, unique per workstream.

But the CLI/JSON surface still says:

  Table headers:     "id"        (in mu task list/next/ready/blocked/goals/show/notes/tree)
                     "agent"     (in mu workspace list — could clarify "agent name")
  JSON keys:         "localId"   (in --json output — preserves the v4 column name)
  Error messages:    "task <id> not found"
  Help text:         "id of the task to claim"
  SKILL.md:          consistently says "task <id>" / "agent <name>"

The SKILL.md inconsistency is most telling: agents are referenced by NAME, tasks by ID, but they're literally the same shape now (per-workstream-unique TEXT identifier).

═══ TWO INDEPENDENT QUESTIONS ═══

Q1. **Cosmetic alignment** — should the CLI column header read "task" / "name" instead of "id"?
  - Pros: matches the post-v5 mental model. Operators don't think about surrogate ids; renaming the visible column matches what they actually care about.
  - Cons: drift from JSON key (which stays `localId` for backward compat). Two names for the same thing in human-vs-machine output.
  - Recommend: rename the visible column to "task" (or "name" — pick one). Keep `localId` in JSON for stability. Document the human/machine split in CHANGELOG.

Q2. **Qualified references** — should verbs accept `<workstream>/<task-name>` to disambiguate when multiple workstreams have the same task name?
  - Today: `mu task show design` errors with "task design not found" if -w isn't set. With -w wsA: shows wsA/design. The operator can't say "show wsB/design" without re-setting -w.
  - Proposed: every verb that takes a task identifier accepts EITHER:
      - bare name → resolves via current workstream context (today's behaviour)
      - qualified `<workstream>/<name>` → no -w needed; resolves directly
  - The same applies to agents: `mu agent show worker-1` (current ws) vs `mu agent show roadmap-v0-2/worker-1` (cross-ws).
  - Implementation: parse-at-CLI-entry. If the operator string contains '/', split into (workstream, name). Else use the resolved workstream context.
  - Out of scope to allow surrogate ids on the CLI (`mu task show 42`) — that's the anti-feature-pledge "no internalId leakage" line.

═══ AUDIT SCOPE ═══

For each verb in mu --help (~50), enumerate:
  1. Does it produce a "task" / "agent" / "approval" identifier in human output? (Yes for nearly all read verbs and most writes.)
  2. Does it accept a "task" / "agent" / "approval" identifier as input? (Yes for show/claim/close/note/etc.)
  3. Is the column header / arg label consistent with "this is a per-scope name" semantics?
  4. Does the JSON key drift from the human label (and is that drift documented)?

Output: docs/OUTPUT_LABELS_AUDIT.md (small) + a per-verb decision matrix.

═══ DELIVERABLES ═══

PHASE 1 — audit (this task) → docs/OUTPUT_LABELS_AUDIT.md
  Walk every verb. Three columns: current human label, current JSON key, recommendation.
  Pick a single naming convention: "task" + "name" (per-entity) and stick to it.
  Recommend the CLI column header rename + the qualified-ref support; file each as a follow-up if shipping in this PR is too big.

PHASE 2 — visible label rename (follow-up task `output_labels_human_rename`)
  Just the cli-table3 column headers + the `mu agent list` "name" column (unchanged) + the `mu task list` "id" column → "task". JSON keys preserved. ~30 LOC.

PHASE 3 — qualified-ref support (follow-up task `verb_arg_qualified_workstream_name`)
  Parse-at-entry helper that accepts `<ws>/<name>` and resolves directly. ~50 LOC + ~20 LOC tests. Touches every verb that takes an entity id.

═══ WHY THIS IS WORTH DOING ═══

1. The post-v5 mental model is "operators talk in names, mu resolves to ids internally". The CLI surface should match.
2. Cross-workstream operations (mu task show roadmap-v0-2/snap_dogfood from inside the mufeedback session) is a real friction we hit this session — required setting MU_SESSION just to peek.
3. Qualified refs unlock the deferred `nit_no_task_move_verb` (since `mu task move design --to wsB` becomes `mu task move wsA/design --to wsB`).
4. AGENTS.md / SKILL.md inconsistency ("task <id>" vs "agent <name>") goes away.

═══ ANTI-FEATURE GUARDRAILS ═══

  - Don't expose surrogate ids on the CLI. Internal ids stay internal forever.
  - Don't add a third name format. Two formats max (bare name + qualified ws/name).
  - Don't rename JSON keys. JSON shape is for scripting; backward compat matters more than naming purity.
  - Don't add a fuzzy-match (`mu task show des*`). The bare-name and qualified-name forms are it.

═══ NEXT ═══

Operator decides: claim this audit task (~0.5d) or defer until v0.2 → v0.3 boundary. The audit IS valuable post-v5; the implementation phases (rename + qualified-refs) are smaller and can be wave-shipped after.

═══ EDGES ═══

Should this block the docs_staleness_review_capstone? YES — the capstone audits all docs for staleness, and the docs reference "task id" / "agent name" inconsistently today. The capstone should reflect whichever convention this audit picks.

(Orchestrator action: add edge after filing.)
```

### #2 by "π - mu", 2026-05-09T13:06:23.114Z

```
ADDENDUM (operator request): clean up JSON keys too. Don't preserve v4 backward compat.

REVISED SCOPE — JSON shape gets the same audit + rename treatment.

═══ THE V4 NOSTALGIA IN JSON KEYS ═══

Today's --json shape carries v4 column names verbatim:

  task:        { localId, workstream, owner, ... }
                       ^                ^
                       └ should be      └ should be ownerName
                         "name"           (or omitted when null)
  
  agent:       { name, workstream, paneId, ... }
                       ^
                       └ already correct (operator-facing name)
  
  workspace:   { agent, workstream, backend, path, ... }
                 ^      ^
                 └      └ both should be agentName / workstreamName
  
  approval:    { slug, workstream, reason, ... }
                 ^
                 └ should be "name"

  agent_logs:  { source, workstream, kind, payload, ... }
                                    ↑
                                    workstream is the NAME (already TEXT
                                    in v5 too — agent_logs is
                                    intentionally not FK-cascaded so the
                                    log row outlives the workstream
                                    rename / destroy)

═══ THE PRINCIPLE ═══

Pick one consistent convention and apply it everywhere:

  - Operator-facing identifier: ALWAYS `name` (singular noun). Per-entity scope is implicit from context. Drop `localId`, `slug`, and the bare `agent` / `workstream` field that's actually a name reference.
  - Reference-to-another-entity-by-name: `<entityType>Name`. So `ownerName` (not `owner` or `ownerId`), `workstreamName` (not `workstream`), `agentName` (when a workspace row references its agent).
  - Surrogate INTEGER ids: NEVER appear in --json. They're internal-only.
  - Composite scope-name pairs: when needed (cross-workstream queries, listTasksByOwner returning tasks from multiple workstreams), include `workstreamName` alongside `name` so the consumer can disambiguate.

═══ THE RENAME TABLE (every entity) ═══

  task:        v4-shape: { localId, workstream, owner, ... }
               v5-clean: { name, workstreamName, ownerName | null, ... }
  
  agent:       v4-shape: { name, workstream, paneId, ... }
               v5-clean: { name, workstreamName, paneId, ... }
                                  ^^^^^^^^^^^^^
                                  rename `workstream` → `workstreamName`
  
  workspace:   v4-shape: { agent, workstream, backend, path, ... }
               v5-clean: { agentName, workstreamName, backend, path, ... }
  
  approval:    v4-shape: { slug, workstream, reason, requestedBy, ... }
               v5-clean: { name, workstreamName, reason, requestedBy, ... }
  
  workstream:  v4-shape: { name, tmuxAlive, agents, tasks, ... }
               v5-clean: { name, tmuxAlive, agentCount, taskCount, ... }
                                            ^^^^^^^^^^  ^^^^^^^^^
                                            already plural-y; rename to *Count for clarity
  
  task_note:   v4-shape: { id (INTEGER autoincrement), taskId (TEXT), author, content, ... }
               v5-clean: { author, content, createdAt, ... }
                          ↑ drop id (autoincrement = internal); drop taskId (caller already knows)
                          
  agent_log:   v4-shape: { seq, workstream, source, kind, payload, ... }
               v5-clean: { seq, workstreamName, source, kind, payload, ... }
                          ↑ keep seq (it IS the operator-facing ordinal for `--since SEQ`)

═══ DELIVERABLE UPDATE ═══

The audit doc + the per-verb decision matrix now covers BOTH human labels AND JSON keys. The PHASE 2 follow-up task expands to:

  PHASE 2 — labels + keys aligned
    - cli-table3 column headers renamed (visible)
    - JSON keys renamed per the table above
    - --json shape change is BREAKING for any external consumer
    - CHANGELOG entry under [Unreleased] / **Breaking**: every --json shape changed
    - jq one-liner migration recipes in CHANGELOG (e.g. `.localId` → `.name`)
    - tests updated wholesale

PHASE 3 (qualified refs) is unchanged; orthogonal to the rename.

═══ WHY NO BACKWARDS COMPAT ═══

Per operator: clean and sane. The same reasoning as the schema_v5 aggressive migration:
  - mu is pre-1.0. No third-party consumers.
  - The CLI is the only --json consumer in the repo (test/json-output.test.ts and the like).
  - A breaking --json shape change today costs one batch of test rewrites; the same change at 1.0 costs every external script.
  - Carrying v4 nostalgia into v5 because "someone might be parsing it" violates VISION.md "be small, be honest".

═══ ANTI-FEATURE GUARDRAILS (UPDATED) ═══

Same as before, plus:
  - Don't add a `--json-shape v4` compat flag. Anti-feature.
  - Don't emit BOTH old and new keys. The brief moment of "what does mu return?" confusion is worth the long-term cleanliness.
  - Don't add a `_meta` block with rename hints. Just rename.
  - Don't expose surrogate ids in JSON either ("internalId" was tempting; per VISION pledge, NEVER without a real consumer ask).

═══ ESTIMATED EFFORT BUMP ═══

Was 0.5d for the doc + 2 follow-ups. Now:
  - PHASE 1 audit: 0.5d (unchanged; doc covers labels + keys together)
  - PHASE 2 ship: ~0.7d (was 0.3d; key renames hit every test that asserts JSON shape, plus CHANGELOG migration recipes)
  - PHASE 3 qualified refs: ~0.5d (unchanged)

Total: ~1.7d across the chain. Each phase is its own task; the audit lands first.
```
