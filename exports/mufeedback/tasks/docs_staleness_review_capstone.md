---
id: "docs_staleness_review_capstone"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: "worker-mf-1"
created_at: "2026-05-09T08:44:39.844Z"
updated_at: "2026-05-09T16:21:41.466Z"
blocked_by: ["agent_close_discipline_gap", "audit_cleanups_post_schema_v5_wave", "audit_verbs_typed_vs_sql", "bug_adopt_verb_unwired", "bug_pane_title_glyph_stuck_at_needs_input", "bug_v5_name_clash_silent_misroute", "export_tasks_to_md_folder", "output_id_vs_name_audit", "reconcile_split_dryrun_into_status_only_mode", "review_code_assert_in_workstream_smell", "review_code_banner_quiet_env_repeated", "review_code_cli_tasks_oversize", "review_code_cli_tasks_re_export_indirection", "review_code_decorate_with_staleness_n_plus_one", "review_code_destroy_freed_workspaces_double_count", "review_code_evidence_suffix_double_doc", "review_code_hud_event_color_regex_drift", "review_code_last_claim_actor_brittle", "review_code_resolve_log_workstream_branch_dup", "review_code_resolveselfnameoruser_dup_resolveself", "review_code_should_overwrite_status_dup", "review_code_spawn_workspace_dance_too_clever", "review_code_state_hud_in_progress_query_dup", "review_code_taskerrors_sanitise_lives_in_errors", "review_code_unescape_note_text_placeholder_brittle", "review_code_wait_test_seam_unwired", "review_test_claim_integration_xws_rewrite", "review_test_color_enabled_no_color_module_load_caveat", "review_test_destroy_failed_workspaces_uncovered", "review_test_invalid_id_overspecs_sanitised_command", "review_test_listtasksbyowner_xws_owner_state_unreachable", "review_test_print_next_steps_stderr_branch_uncovered", "review_test_status_emoji_drift_only_three_glyphs", "review_test_tasks_mu_agent_name_env_pollution", "review_test_workspace_cleanup_throws_monkeypatch_smell", "review_test_workspace_staleness_behind_value_unanchored", "schema_surrogate_pks_for_global_uniqueness", "schema_v5_cleanups", "schema_v5_cli_boundary", "schema_v5_design_amendments", "schema_v5_drop_migrations_ts", "schema_v5_migration_script", "schema_v5_sdk_signatures", "tables_truncate_long_cols_audit", "v5_prune_v4_fallback_branches"]
blocks: []
---

# capstone: review every doc for staleness/drift after the v0.2 wave; reconcile against shipped CHANGELOG entries

## Notes (5)

### #1 by π - mu, 2026-05-09T08:45:39.787Z

```
CAPSTONE TASK: runs LAST. Blocked by every other open mufeedback task in this wave so the orchestrator's `mu task ready` naturally surfaces it only when the rest are done.

═══ DELIVERABLE ═══

A docs-staleness audit + corrective patch landing as ONE commit. Output:
  - Every .md file in the repo audited against the shipped code surface as of HEAD when this task is claimed.
  - One commit per category of drift if scopes diverge enough; otherwise one consolidated commit.
  - Final CHANGELOG entry under [Unreleased] / Changed: "Doc staleness sweep — N files updated, M obsolete sections removed."

═══ FILES IN SCOPE (audit each) ═══

  README.md
  AGENTS.md
  CHANGELOG.md                     # entries between sections; format consistency
  docs/USAGE_GUIDE.md              # verb list + sql workaround tables; promote whatever the wave shipped
  docs/VOCABULARY.md               # canonical terms; new ones from this wave (status-only mode? muTable helper? stale workspace?)
  docs/ARCHITECTURE.md             # module layout (might have shifted post-refactor + new files like src/cli/_table.ts if landed)
  docs/ROADMAP.md                  # promoted v0.2 items vs deferred; honesty pass on anti-feature pledges (any new feature broke a pledge?)
  docs/VISION.md                   # pillars; check claims against current behaviour
  skills/mu/SKILL.md               # verb count, the orchestrator-discipline section, the workspace-stale workaround should be removed once Option 1 lands

═══ AUDIT METHOD ═══

For EACH file:
  1. Read it end to end.
  2. For every code-surface claim (verb name, flag name, schema column, file path, behaviour described): cross-check against current src/ + dist/cli.js --help.
  3. Flag drift in three buckets:
     a. STALE FACTS — wrong now (e.g. "src/cli.ts is 1851 LOC" once the cli_tasks_oversize refactor lands).
     b. MISSING ENTRIES — newly-shipped feature not yet documented (e.g. workspace staleness column in USAGE_GUIDE.md, --sort flag in SKILL.md verb list).
     c. OBSOLETE WORKAROUNDS — sql recipes that have been promoted to typed verbs (per AGENTS.md rule: "If you added a typed verb, the corresponding mu sql workaround row was removed from docs/USAGE_GUIDE.md").

═══ KNOWN-LANDING-IN-THIS-WAVE FACTS THAT NEED DOC REFLECTION ═══

(Use this as a checklist; add any others that ship between this task being filed and being claimed.)

  - --sort flag for mu task list/next/ready                  → SKILL.md verb list, USAGE_GUIDE.md
  - workspace staleness column + warn line                   → USAGE_GUIDE.md, VOCABULARY.md ("stale workspace" already added per worker-mf-1's own SKILL.md hint)
  - HOME-as-projectRoot guard + cleanup-on-throw             → USAGE_GUIDE.md
  - HUD heavy 4-side border + glyph audit                    → SKILL.md, VOCABULARY.md
  - colorEnabled / NO_COLOR                                  → mention in USAGE_GUIDE.md or SKILL.md if env-var support is operator-facing
  - cross_workstream_claim_for guard                          → USAGE_GUIDE.md (typed-error coverage)
  - TaskIdInvalidError typed                                 → USAGE_GUIDE.md
  - waitForTasks deadline clamp                              → USAGE_GUIDE.md if behaviour changed visibly (it should — pollMs > timeoutMs is now correct)
  - resolveSelfActor inline / RawTaskRowForState collapse / views_recreated_thrice → no doc reflection needed (pure internal cleanup)
  - status-only reconcile mode                               → ARCHITECTURE.md (new mode is a load-bearing seam)
  - tables truncate audit                                     → no doc reflection (visual fix)
  - bug_workspace_stale_parent_silent_drift Option 2          → SKILL.md "Stale workspace" warn-line tip; the workaround sentence I told the worker to add to SKILL.md should go (Option 2 IS the surfacing)
  - schema_v5 (if landed)                                     → MASSIVE doc surface change (ARCHITECTURE.md schema diagram, VOCABULARY.md PK semantics, USAGE_GUIDE.md any sql recipe that referenced text PKs, README.md mentions of "task ID is global") — if schema_v5 doesn't ship in this wave, just note in the audit "schema_v5 design committed; doc reflection deferred to schema_v5 follow-up"
  - workstream export verb (if landed)                        → SKILL.md verb list, USAGE_GUIDE.md export pattern
  - verb audit (if landed)                                    → docs/VERB_AUDIT.md gets cross-linked from ROADMAP.md and ARCHITECTURE.md
  - 26+ deferred review_* tasks worked                       → CHANGELOG entries grouped if appropriate; no other doc surface

═══ HONESTY GUARDRAILS ═══

  - DON'T blanket-rewrite for style. The ask is staleness fix, not prose polish.
  - DON'T add doc sections for features that haven't shipped. Defer to the actual feature task's doc-update step.
  - DO call out drift even if you don't fix it — file as a follow-up if the fix is non-trivial (>50 LOC of doc rewrite).
  - DO be skeptical of the existing claims. Things like "fits in <300 LOC" or "713 tests" or "schema v4" embedded in docs MUST be reverified.
  - DO update LOC numbers if they're materially wrong; don't bother if drift is <10%.

═══ EDGE BEHAVIOR ═══

This task is BLOCKED BY every other open mufeedback task in this wave. Setup:

  for t in $(mu sql "SELECT local_id FROM tasks WHERE workstream='mufeedback' AND status='OPEN' AND local_id != 'docs_staleness_review_capstone'" --json | jq -r '.[]'); do
    mu task block docs_staleness_review_capstone --by "$t" -w mufeedback
  done

(The orchestrator runs that immediately after filing this task — the operator already asked for it.)

═══ FAILURE MODES ═══

  - Some open tasks may NOT be addressed in this wave (DEFER, REJECT). That's fine — the capstone unblocks as soon as ALL its blockers reach a TERMINAL status (CLOSED / REJECTED / DEFERRED). It's not waiting for "ship every one".
  - If schema_v5 is in flight but mid-implementation when capstone is claimed, the doc-audit should be staged: do all the OTHER doc work, leave a "schema_v5 doc updates pending its merge" note, close as partial — capstone respawns when schema_v5 lands.
  - If 30+ stale-fact bullets accumulate, file as `docs_staleness_round_2` and ship a partial. Don't slip the capstone into a many-day sprawl.

═══ NOTES CONTRACT ═══

Standard FILES / COMMANDS / FINDINGS / DECISION / NEXT / VERIFIED / ODDITIES.
VERIFIED should include: word-count or grep-based diff between pre and post for each touched .md (e.g. "USAGE_GUIDE.md: +14/-9 lines"). And: `npm run typecheck && lint && test && build` still green (docs-only, but verify nothing accidentally broke).

═══ SCOPE GUARD ═══

~0.5 days. The audit IS the work. ~150-300 LOC of .md changes is the realistic budget; bigger means scope-creep into "docs rewrite" which is out.
```

### #2 by π - mu, 2026-05-09T08:46:05.376Z

```
ADDENDUM (operator request): SKILL.md must stay TERSE and to the point.

The skill file is what the LLM running INSIDE an agent pane sees in its context window — every byte costs tokens, every paragraph competes for the model's attention with the actual task at hand. House style is dense one-liner bullets, not flowery prose. The operator already pulled back on a prior SKILL.md edit in this session for verbosity (commit dd8964c was rewritten before commit per "before committing SKILL.md, re-check your edits and make sure they are terse and to the point").

CONCRETE GUARDRAILS for the SKILL.md portion of this audit:

  - Prefer striking sentences over adding them. If a new feature can be captured by a 1-line bullet under an existing DOs/DON'Ts section, do that instead of adding a new subsection.
  - Cut "X deliberately doesn't automate Y because..." rationale — if the rationale is needed it lives in VOCABULARY.md or ARCHITECTURE.md, not in the operator-facing skill.
  - Cut "tip: ..." paragraphs that wrap a verb the agent would read about anyway via `mu <verb> --help`.
  - The orchestrator-discipline section should remain the smallest correct shape; if a new pattern needs to land, ADD ONE BULLET, don't add a 12-line subsection.
  - Verb-list section: must stay sorted, must stay one-line-per-verb. If a new verb shipped this wave, it gets one bullet — not a paragraph.
  - "When to reach for mu" / "DOs" / "DON'Ts" sections: tighten by deletion, not addition. A staleness-audit is a great moment to ALSO cut accumulated cruft.

INVARIANT (run as part of VERIFIED):
  wc -l skills/mu/SKILL.md  # post-audit should be ≤ pre-audit OR within ~10% if a genuine new section was needed.
  grep -c '^  -' skills/mu/SKILL.md  # bullet count; should grow proportionally to actual new verbs/concepts shipped, not to your enthusiasm.

If the audit finds SKILL.md is ALREADY too long — file it as a follow-up `skill_md_tighten_round_N` task with specific cut candidates (full sentences quoted from the file). Don't blanket-rewrite.

The bar: a fresh agent loading the skill should reach the "ok I get it" point in well under one minute of reading. Today's SKILL.md is ~620 lines; if this audit pushes it over 700 without commensurate genuine value, push back.
```

### #3 by π - mu, 2026-05-09T10:22:07.481Z

```
ADDENDUM (operator request): drastically compress the [Unreleased] CHANGELOG entries.

CURRENT STATE (as of writing): CHANGELOG.md is 2474 lines, 88 bullets total. The [Unreleased] section grew unbounded across this session — every wave landed a 20-50 line bullet per task, and 30+ tasks shipped means hundreds of lines of changelog for a single pre-release. Many entries narrate the design alternatives weighed, which belongs in task notes, not CHANGELOG.

THE BAR (apply during the capstone audit):

  - Every [Unreleased] bullet: ONE summary line + at most ONE supporting paragraph (~3-5 lines). Anything longer is verbosity.
  - Cut "Pre-fix..." narration. Most can be implied from the verb that ships.
  - Cut "alternatives considered" lists. Those live in the task notes (which are durable and queryable via mu task notes <id>); CHANGELOG points to them ("see mu task notes review_code_X").
  - Cut LOC counts unless materially load-bearing (e.g. a -300 LOC delete is worth noting; +18/-5 isn't).
  - Cut "behaviour unchanged" — implied by the section the bullet lives in (Changed/Fixed do; Removed says so; Added is new).
  - Keep: the closes-task-id reference, the user-visible behaviour summary, breaking-change call-outs.

EXAMPLE COMPRESSION

  BEFORE (typical current bullet, ~20 lines):
    - **`MU_BANNER_QUIET` opt-out moved into the tmux border helpers;
      callers no longer wrap them in env guards.** Closes
      `review_code_banner_quiet_env_repeated` in `mufeedback`. Three
      call sites (`spawnAgent`, `cmdAdopt`, `cmdInit`) had near-
      identical `if (process.env.MU_BANNER_QUIET !== "1") { … }`
      blocks around `enableMuPaneBorders` / `enableMuPaneBordersForSession`
      — a change to the env-var name or to the silence policy needed all
      three found and updated, and a future caller could easily forget
      the guard and set the border even when the operator wanted quiet.
      `enableMuPaneBorders` and `enableMuPaneBordersForSession` now
      self-check `MU_BANNER_QUIET=1` (no-op when set), and a new
      `enableMuPaneBordersForPane(paneId)` collapses the
      `getWindowIdForPane` → `enableMuPaneBorders` two-step that the
      spawn / adopt sites repeat. The three callers are now one-liners.
      Behaviour unchanged.

  AFTER (target shape, ~3 lines):
    - **`MU_BANNER_QUIET` self-check moved into the tmux border helpers.**
      Closes `review_code_banner_quiet_env_repeated`. Three callers
      (`spawnAgent`, `cmdAdopt`, `cmdInit`) drop their identical env-guard
      preamble; `enableMuPaneBorders` / `enableMuPaneBordersForSession`
      no-op on `MU_BANNER_QUIET=1` themselves.

PROCESS

The capstone-audit pass should:
  1. Walk every [Unreleased] bullet (currently ~30+).
  2. Compress per the bar above.
  3. Group obviously-related entries if useful (e.g. all the staleness work; all the test-suite gaps; all the dedup wins).
  4. Verify no closes-id reference is lost.
  5. After compression, [Unreleased] should be ~150-300 lines total, down from current ~600+.

DON'T

  - Drop any closes-task-id link. Those are how future archaeology finds the rationale.
  - Drop breaking-change notices.
  - Compress entries from older release sections (0.1.0, etc.) — those are released and stable.
  - Substitute prose for the bullet's content (one line of "see X" replacing actual content is too thin).

VERIFY

  wc -l CHANGELOG.md  # should drop substantially
  grep -c "^- \*\*" CHANGELOG.md  # bullet count unchanged (we're compressing each, not deleting any)
  for id in $(grep -oE "review_[a-z_]+\|nit_[a-z_]+\|bug_[a-z_]+\|fix_[a-z_]+\|feat_[a-z_]+" CHANGELOG.md | sort -u); do mu task show "$id" -w mufeedback --json >/dev/null 2>&1 || echo "STALE LINK: $id"; done
```

### #4 by π - mu, 2026-05-09T13:13:06.914Z

```
ADDENDUM (operator request): three concrete checks during the capstone audit pass.

═══ 1. DUPLICATED PARAGRAPHS ═══

Several docs have grown by accretion across the v0.2 wave; some paragraphs got copy-pasted across files (or twice within the same file). Hunt them.

Method:
  - For each .md, find paragraphs (3+ consecutive non-blank lines) that appear ≥2× in the same file or across files.
  - awk-paragraph-extract + sort + uniq -c works for the same-file case; for cross-file, hash each paragraph and compare across the corpus.

Concrete suspects (operator-noticed today; not exhaustive):
  - docs/SCHEMA_v5_DESIGN.md and docs/ARCHITECTURE.md may both narrate the surrogate-PK pattern.
  - docs/USAGE_GUIDE.md and skills/mu/SKILL.md likely overlap on the orchestrator-loop / DOs / DON'Ts narration.
  - CHANGELOG.md within [Unreleased] has multiple "Closes review_code_X — surfaced live during snap_dogfood…" preambles that look templated.

Resolve duplicates by canonicalising — pick ONE home for each piece of content, link from the others. Do NOT delete content blindly; some duplication is intentional (e.g. SKILL.md re-states the orchestrator loop because the in-pane LLM doesn't have USAGE_GUIDE.md in its context).

Honest principle: if the duplicate is "this paragraph is the canonical statement of X, and any reader of file Y benefits from seeing X at this point" — that's a legitimate cross-cut and stays. If the duplicate is "I forgot I'd already written this and wrote it again" — collapse.

═══ 2. BROKEN LINKS ═══

README.md has broken links into other docs (operator-noticed today). Fix those. Also audit every .md for:
  - relative links to files that have moved/renamed (anything renamed by the cluster split: src/cli.ts → src/cli/*.ts; src/tasks.ts → src/tasks/*.ts; src/agents.ts → src/agents/*.ts)
  - links to docs/ files that no longer exist (anything mentioned in old roadmap entries)
  - links to verb names that have been renamed/removed (post-audit_verbs work: search/blocked/goals removal will create a wave of these)
  - links to schemas / table names that changed (post-v5 — \`tasks.local_id\` is still there but \`tasks.owner\` is now \`tasks.owner_id\`, etc.)

Method: find docs/ -name '*.md' -o -name 'README*' -o -name 'AGENTS*' -o -name 'CHANGELOG*' -o -name 'SKILL*' | xargs grep -oE '\[[^]]+\]\([^)]+\)' | parse-and-check.

For each broken link, either:
  - Fix the target path (most common — the file just moved).
  - Remove the link (if the target was deleted intentionally, e.g. a feature was rejected).
  - Mark TODO for follow-up if the fix is ambiguous (file as a separate task; don't slip the capstone).

═══ 3. README.md COMPRESSION ═══

The README has accreted across v0.2 — installation, sales pitch, usage examples, schema notes, troubleshooting, design references, etc. The operator's ask: cut to the essentials.

Target shape (~150-250 lines, NOT 600+):

  1. ONE-LINE PITCH — what mu is, who uses it.
  2. INSTALL — npm install / brew install / build-from-source. One-paragraph each.
  3. QUICK USAGE — 3-5 commands that get a new user from zero to "I see what this does":
      mu workstream init demo
      mu task add design --title "..." --impact 60 --effort-days 1
      mu agent spawn worker-1 -w demo --workspace
      mu task claim design -w demo --for worker-1 --evidence "..."
      mu state -w demo
  4. LINKS to deep docs:
      - docs/USAGE_GUIDE.md   — every verb, with examples
      - docs/ARCHITECTURE.md  — module layout + load-bearing seams
      - docs/VOCABULARY.md    — canonical terms
      - docs/VISION.md        — design pillars
      - docs/ROADMAP.md       — what's next
      - docs/SCHEMA_v5_DESIGN.md (NEW post this wave) — schema
      - docs/VERB_AUDIT.md (NEW post this wave) — every verb scored
      - skills/mu/SKILL.md    — what the LLM running inside an agent sees

Cut from the README:
  - Long verb-by-verb explainers (those live in USAGE_GUIDE).
  - Repeating the SKILL.md orchestrator loop (link to it).
  - Schema diagrams (link to SCHEMA_v5_DESIGN).
  - Long FAQ (collapse to "see USAGE_GUIDE troubleshooting").
  - Multiple changelog excerpts (link to CHANGELOG, don't quote).

The README is a sales-and-onboarding doc. The deep docs are for users who decided to commit. Optimise the README for the 30-second reader.

═══ INVARIANTS POST-CAPSTONE ═══

  wc -l README.md     # should be ≤ 250 lines (currently ~? — check; cut to that bar)
  wc -l CHANGELOG.md  # already-noted compression target from prior addendum (~150-300 [Unreleased] lines)
  No broken links: a follow-up grep / link-check passes.
  No within-file paragraph duplicates (>3 lines) reported by uniq -c.

═══ ANTI-FEATURE GUARDRAILS ═══

  - Don't write a new style guide. Just fix what's drifted.
  - Don't add ASCII diagrams to the README. Keep it text-prose.
  - Don't make the README depend on an external image / GIF (anti-feature; pixels rot, text doesn't).
  - Don't auto-generate the verb list in the README; link to USAGE_GUIDE which has it.
```

### #5 by π - mu, 2026-05-09T13:13:55.677Z

```
ADDENDUM (operator request): drop temporary implementation-plan artifacts once they've shipped.

═══ THE PRINCIPLE ═══

Implementation plans are scaffolding for a specific landing. Once the work lands and the code reflects the new shape, the plan stops being a "design doc" and becomes "historical narrative about a transition that is now in main". Keeping them around as docs/ files implies they're current, drifts in dangerous ways (the doc says X, the code does Y because we changed our minds during impl), and dilutes the docs/ surface every reader has to navigate.

The schema_v5 wave just shipped exactly this kind of artifact: docs/SCHEMA_v5_DESIGN.md, scripts/migrate-v4-to-v5.ts, the schema_v5_* task chain. Once schema_v5_cleanups closes, those artifacts have served their purpose.

═══ DROP DURING THE CAPSTONE ═══

  docs/SCHEMA_v5_DESIGN.md
    What it was: design-anchor for the schema_surrogate_pks_for_global_uniqueness work.
    What it becomes post-landing: a 691-line doc that DUPLICATES what's already in src/db.ts (the v5 schema itself), docs/ARCHITECTURE.md (the boundary discipline), and the CHANGELOG entries.
    DECISION: delete. Anything load-bearing it contains gets pulled INTO docs/ARCHITECTURE.md (the surrogate-PK pattern as a load-bearing seam) before the doc is removed. Cross-link from CHANGELOG to ARCHITECTURE for the design rationale.
    Note: the schema doc also has the historical migration story (v4 → v5 ordering, why aggressive) — that goes into the CHANGELOG entry for schema_v5_migration_script if it isn't there already. CHANGELOG is the right home for one-time historical narrative.

  scripts/migrate-v4-to-v5.ts
    What it was: one-off migration tool. Operator runs it once per DB.
    What it becomes post-landing: an unused 569-line script in scripts/ that someone might find and run accidentally.
    DECISION: delete after a reasonable cooling period. The schema_v5 design doc explicitly says "after all known operator DBs are migrated, the script can be deleted in a follow-up commit". The capstone is that follow-up moment.
    BEFORE deleting, verify: every known operator DB (this dev's DB at minimum) has been migrated. Loud-fail hook in openDb stays as the safety belt for any straggler — they get a clear error pointing to git history (\`git show <commit>:scripts/migrate-v4-to-v5.ts\` if they need it).
    Optional: replace the script with a 5-line stub that prints "this script was deleted in <commit-sha>; restore from git history if needed" (to soften the operator-confusion if they look for it).

  test/migrate-v4-to-v5.integration.test.ts
    What it was: regression test for the migration script.
    What it becomes post-landing: tests for code that no longer ships.
    DECISION: delete alongside the script. The test was load-bearing during the schema_v5 wave; once the script is gone the test has no production code to guard.

═══ THE GENERAL RULE ═══

Any file that's named for a SPECIFIC OPERATION (migrate-vN-to-vM, decision-doc-for-X, transition-plan-Y) is temporary by construction. Periodic cleanup post-landing.

Files that AREN'T this shape (and stay):
  - docs/ARCHITECTURE.md (current architecture, evolves with the codebase)
  - docs/VOCABULARY.md (canonical terms, evolves)
  - docs/USAGE_GUIDE.md (current usage, evolves)
  - docs/ROADMAP.md (forward-looking, evolves)
  - docs/VISION.md (load-bearing pillars, slow-evolving)
  - docs/VERB_AUDIT.md (the audit IS a periodic exercise; could be re-run; kept as a "current state" snapshot rather than a one-off — operator's call. RECOMMEND: keep, mark as a snapshot with a date stamp.)
  - skills/mu/SKILL.md (the LLM-facing surface, current)
  - CHANGELOG.md (immutable history)
  - README.md (current pitch)
  - AGENTS.md (current contributor guide)

═══ CHECK DURING CAPSTONE ═══

  ls docs/                     # any other transition-doc-shaped files? (SCHEMA_v5_DESIGN, ...?)
  ls scripts/ | grep -i 'migrate\|transition\|fixup\|backfill'   # any other one-off scripts?
  
For each candidate, decide: is the work it represents shipped? If yes → delete. If no → keep, but mark with status if not obvious.

═══ SAFETY ═══

Delete in a SEPARATE commit from the rest of the capstone work, with a clear message ("docs: remove temp impl artifacts post schema_v5 landing"). git history preserves everything; restore is one command. Don't bundle the deletion with substantial doc rewrites — keeps the diff readable + the revert trivial.

If anyone needs the v5 design rationale later, it lives in:
  - The CHANGELOG entry under [Unreleased] / Breaking → schema bumped to v5
  - docs/ARCHITECTURE.md → the surrogate-PK pattern + boundary discipline
  - git log -p docs/SCHEMA_v5_DESIGN.md → the original doc, unchanged in git history forever
  - The closed schema_v5_* task notes (mu task notes <id>) → why we did it the way we did

═══ ANTI-FEATURE GUARDRAILS ═══

  - Don't auto-archive into a docs/archive/ folder. Just delete; git is the archive.
  - Don't keep "for educational purposes" — git log is the educator.
  - Don't add a "deprecated" header to the doc and leave it. Either it's current or it's gone.
```
