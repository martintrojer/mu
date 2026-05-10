---
id: "tmux_pane_border_top_and_bottom_plus_glyph_audit"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-09T05:38:41.230Z"
updated_at: "2026-05-09T06:13:19.390Z"
blocked_by: []
blocks: []
---

# tmux pane border: enable top+bottom (not just top); audit glyphs to ensure STATUS_EMOJI is the only source

## Notes (2)

### #1 by π - mu, 2026-05-09T05:39:37.959Z

```
TWO-PART TASK: (A) double-band pane border, (B) glyph audit. Both small; ship together.

═══ PART A: pane border on top AND bottom ═══

CURRENT STATE
  src/tmux.ts:597-598 sets:
    pane-border-status top
    pane-border-format " [mu] #{pane_title} "
  Applied per workstream window in src/cli/workstream.ts:56-62 on init/re-init.

CONSTRAINT
  tmux's pane-border-status only accepts {off, top, bottom} — there is NO "all" or "left/right". Borders themselves are ALWAYS drawn on all four sides between adjacent panes (and around a single full-window pane only when pane-border-lines is non-default + the window has chrome). The "status text" (the [mu] name·glyph·task line) is a SEPARATE band that can sit on top OR bottom only.

  Top+bottom together is NOT directly supported by a single tmux option. Two routes:

  Route 1 (recommended, tmux-native): set status on TOP, AND make the bottom border visible by configuring `pane-border-lines` to a heavy/double style + apply a bold/dim `pane-border-style` so the bottom edge is visually emphasized even though it carries no text. Operator gets: top = labeled status band; bottom = visible "this is a mu-managed pane" rule.
    Pros: uses one tmux option-set per window; no per-pane bookkeeping; survives pane resize/split.
    Cons: bottom rule is non-textual (just a visual frame).

  Route 2 (status on both bands): tmux ≥3.4 supports `pane-border-status top` per-window AND a SECOND status via `pane-border-format` rendering a multi-line value with an embedded `
`? — verify against `man tmux`. If supported, render the same `[mu] name·glyph·task_id` on top, and on bottom render a complementary line (e.g. `[mu] workspace=<dir> · pid=<n>`). If NOT supported, fall back to Route 1.
    Pros: more info per pane.
    Cons: doubles vertical chrome; may collide with pi/claude TUI status lines.

  RECOMMEND ROUTE 1 unless verification shows route 2 is cheap.

CHANGES (Route 1)
  src/tmux.ts (the workstream-window setup helper around line 597):
    add:
      set-option -w -t <target> pane-border-lines heavy   # or "double"
      set-option -w -t <target> pane-border-status top    # unchanged
      set-option -w -t <target> pane-border-format " [mu] #{pane_title} "  # unchanged
      # Optional: pane-active-border-style fg=cyan,bold + pane-border-style fg=brightblack
      #   so inactive panes have a dim frame and the active one pops.
  src/cli/workstream.ts:56-62: no change beyond the helper signature; still benign on older tmux.
  Verify against tmux ≥ 3.0 (the version we already require by virtue of using -T pane titles).

TESTS
  test/tmux.integration.test.ts: assert that after workstream init, `tmux show-options -w -t mu-<ws> pane-border-lines` returns the configured value. Skip when $TMUX is unset (pattern already in place).
  Unit tests: setup helper now passes the extra args — assert exec args via mocked executor (3 set-option calls, not 2).

NEXT-STEP HINT (output)
  workstream init's success message gains: "pane border: top + bottom rule (heavy lines)". One line; don't wax poetic.

═══ PART B: STATUS_EMOJI audit — single source ═══

CURRENT STATE
  src/agents.ts:223 STATUS_EMOJI is the canonical map (Nerd Font private-use codepoints; chosen because they're all 1 codepoint + 1 cell wide, so cli-table3 widths line up). review_code_status_emoji_two_sources caught + fixed a 2/7 disagreement between this and statusIcon a few days ago — that's already shipped. Today statusIcon (src/cli.ts:272) is the ONLY consumer; everything else routes through it. Good.

DRIFT FOUND (audit results from grepping every emoji codepoint in the repo)
  1. src/agents.ts:192-197  — DOC COMMENT shows the OLD emoji ('⚙️', '💤', '🛂', '✅') in the title-format examples. The actual STATUS_EMOJI table 30 lines below uses Nerd Font (\uf013 etc). Misleading: anyone reading the comment thinks production renders '⚙️' but it doesn't. FIX: rewrite the comment block to either (a) name the glyphs by their nf-fa label ("nf-fa-cog"), (b) embed the actual codepoints, or (c) reference STATUS_EMOJI directly and not duplicate.
  2. src/agents.ts:211-214  — same issue in the cli-table3 width-alignment comment ('⚙️', '✅' as examples of the OLD problem). Could be left in (it's history) but should be marked "(legacy)" or moved to a CHANGELOG note.
  3. src/tmux.ts:653        — doc string says "renders titles as `name · 💤 · task_id`". Production renders Nerd Font. FIX: update example to the Nerd Font glyph name (the actual codepoint is fine in the comment — it's just example text — as long as it MATCHES what the code emits).
  4. src/agents/adopt.ts:122-124 — same kind of comment drift. Same fix.
  5. test/tmux.test.ts:831-838 — REAL TEST DRIFT. Tests assert parseAgentNameFromTitle("worker-a · 💤") === "worker-a", but composeAgentTitle no longer emits '💤' — it emits the nf-fa-moon_o codepoint. The tests still pass because parseAgentNameFromTitle splits on " · " regardless of what comes after — but the tests are no longer testing the production-shape input. FIX: change the test fixtures to use STATUS_EMOJI.needs_input (etc.) so the test exercises the actual production glyph; that way if STATUS_EMOJI changes, the test breaks loud.

NOT TO TOUCH (legitimately not status glyphs)
  - src/cli/tasks.ts:776  — '✓' / '•' is the mu-task-wait reached/not-reached marker. Different semantic; not agent status. Leave alone.
  - test/verbs.test.ts + test/detect.test.ts — '❯' is the pi-prompt-shape regex for needs_input detection. Input data, not output glyph. Leave alone.

INVARIANT (post-fix)
  grep -rE "[\xe2\x80\xb1\xf0\x9f]" src/ should return ONLY: (a) STATUS_EMOJI declaration, (b) src/cli/tasks.ts:776 (✓/•), (c) any new comment that explicitly references STATUS_EMOJI as "(see STATUS_EMOJI)".

═══ SCOPE GUARD ═══
  Total budget: ~0.3 days. Part A is ~10 LOC + 1-2 tests. Part B is comment fixes (no code) + ~5-10 LOC of test fixture updates. If verification of Route 2 (multi-band) costs >30min, skip it and ship Route 1 + a follow-up task `tmux_pane_border_dual_status_text` for Route 2.

  Do NOT:
    - Add a `--border-style` CLI flag (anti-feature: no config surface for visual chrome).
    - Refactor STATUS_EMOJI into a class / config.
    - Touch the pi-prompt detection glyphs.

═══ TEST PLAN ═══
  npm run typecheck && lint && test && build all green.
  Live-verify the tmux border:
    tmux kill-session -t mu-test-border-a 2>/dev/null
    mu workstream init test-border-a
    mu agent spawn w1 -w test-border-a
    mu agent spawn w2 -w test-border-a
    tmux a -t mu-test-border-a    # eyeball: top band labeled, bottom edge heavy/double rule
    mu workstream destroy -w test-border-a --yes
  Live-verify STATUS_EMOJI is still the only source after fix:
    grep -rE "💤|⚙️|🛂|✅|🔒|❓|❌" src/ test/ | grep -v STATUS_EMOJI | grep -v "(see STATUS_EMOJI)"
  Should return zero hits (or only the deliberately-kept ones).
```

### #2 by worker-mf-1, 2026-05-09T06:13:16.707Z

```
VERIFIED: shipped both parts in commit a159233.

PART A — heavy 4-side pane border:
  src/tmux.ts enableMuPaneBorders now also sets pane-border-lines=heavy,
  pane-active-border-style=fg=cyan,bold, pane-border-style=fg=brightblack.
  Top status band ('[mu] #{pane_title}') unchanged.
  Live tmux verification on this very session:
    $ for o in pane-border-lines pane-active-border-style pane-border-style; do tmux show-options -w -t mu-mufeedback $o; done
    pane-border-lines heavy
    pane-active-border-style fg=cyan,bold
    pane-border-style fg=brightblack
  Visual eyeball: bottom + sides of every pane in this session now carry a
  heavy horizontal+vertical rule; active pane border pops bright cyan,
  inactive panes show the dim brightblack frame. Heavy + cyan/brightblack
  combo is readable; no need to fall back to spec's just-heavy-no-color path.
  Test: test/tmux.test.ts enableMuPaneBorders now asserts 5 set-option calls
  in the right order (was 2).

PART B — STATUS_EMOJI drift cleanup, all 5 sites fixed:
  - src/agents.ts:186-201 (title-format example block): swapped literal
    OLD-emoji codepoints for '<STATUS_EMOJI.busy>' / '<STATUS_EMOJI.free>'
    references, so this comment can never drift again.
  - src/agents.ts:206-211 (column-alignment comment): removed the literal
    '⚙️'/'✅' examples; reworded as '(legacy) Unicode emoji ... gear-with-
    variation-selector'. The substance still teaches WHY Nerd Font wins.
  - src/tmux.ts parseAgentNameFromTitle docstring: '💤' → '<glyph>' with
    explicit pointer to STATUS_EMOJI in src/agents.ts.
  - src/agents/adopt.ts:122-124: Step-4 comment '💤' → '<STATUS_EMOJI>'.
  - test/tmux.test.ts:831-838 (REAL test drift): fixtures now use
    `worker-a · ${STATUS_EMOJI.needs_input}` etc. interpolated from the
    production map, so any future STATUS_EMOJI reshape breaks this test
    loud instead of silently parsing a different glyph.

Invariant grep AFTER fix (the spec's python3 one-liner):
  ./src/cli/state.ts:255: ⚠   (workspace-staleness warning — different
                                semantic, not a status emoji, NOT in spec)
  ./src/cli/state.ts:267: ⚠   (same)
  ./src/cli/tasks.ts:775: ✓   (mu-task-wait reached/not-reached marker —
                                explicitly allowlisted; spec said line 776
                                but it lives on 775, off-by-one in literal)
  Zero status-emoji drift remaining. The two ⚠ are pre-existing and not
  on the drift list (they're a UX warning, not an agent-status glyph).

GATES:
  npm run typecheck — green
  npm run lint      — green (biome --write fixed one auto-import sort)
  npm run test      — 738 passing.
                      2 pre-existing failures in test/tasks.test.ts unrelated
                      to this diff (the --self test asserts USER fallback
                      wins but currentAgentName wins when the test runs
                      INSIDE a mu-managed pane like this one; verified by
                      stashing my diff and re-running — same 2 fails).
  npm run build     — green.

SCOPE: A=~10 LOC (helper) + ~25 LOC (test rewrite). B=comment fixes + ~6 LOC
test fixture rewrite. Well under the 0.3-day budget.

ANTI-FEATURE PLEDGE INTACT: no --border-style flag, no STATUS_EMOJI class
refactor, '✓/•' in cli/tasks.ts:775 + '❯' in detect.test.ts/verbs.test.ts
deliberately untouched.

NEXT STEP: ready for close + commit.
```
