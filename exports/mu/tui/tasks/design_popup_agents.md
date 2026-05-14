---
id: "design_popup_agents"
workstream: "tui"
status: CLOSED
impact: 75
effort_days: 1
roi: 75.00
owner: "designer-2"
created_at: "2026-05-11T10:45:07.373Z"
updated_at: "2026-05-11T11:31:25.726Z"
blocked_by: ["design_card_agents", "design_popup_lifecycle", "design_yank_flow"]
blocks: ["design_complete"]
---

# Design Agents popup: scrollback drill, y/c/s/k yank commands, / filter

## Notes (2)

### #1 by "designer-2", 2026-05-11T11:31:23.655Z

````
FILES:
- (none modified — design-only role; output is this note)
- read: mu task notes design_locked            -w tui
- read: mu task notes design_card_iface        -w tui  (Card/Popup interfaces, AgentsPopup skeleton, PopupVerbKey pool)
- read: mu task notes design_popup_lifecycle   -w tui  (on-open hook, error path, popup tick)
- read: mu task notes design_card_agents       -w tui  (slice fields, attention-bucket sort, status emoji set)
- read: mu task notes design_yank_flow         -w tui  (PopupProps.yank, agents-popup `y` = show, footer/toast)
- read: mu task notes design_global_keymap     -w tui  (in-popup convention, reserved letter pool)
- read: src/agents.ts L284 listAgents / L566 readAgent / L784 listLiveAgents / L82 AgentRow
- read: src/tmux.ts L814  CaptureOptions / L829 capturePane (lines: N → -S -N, visible-only when 0)
- read: src/logs.ts  L131 listLogs (workstream / source / kind / since cursor)
- read: src/workspace.ts L36 WorkspaceRow (path, parentRef, commitsBehindMain)

COMMANDS:
- mu task show design_popup_agents -w tui
- mu task notes {design_locked,design_card_iface,design_popup_lifecycle,design_card_agents,design_yank_flow,design_global_keymap} -w tui
- (zero shell mutations; design-only; ~40 min budget honoured)

================================================================
FINDINGS
================================================================

1. The contract is mostly already locked by upstream notes. This task is
   small: fill the AgentsPopup skeleton in design_card_iface §6 with
   (a) the slice (b) the on-open extra (c) the verbs (d) the render
   layout (e) state-driven verb-suggestion. The reserved-letter pool
   {a b d e f h i l m o p s t u v x z} is the only key surface I get
   to spend; everything else (j/k/g/G/n/N/q/y/c/r/w/Esc/?/+ - = 0/r/F5)
   is global.

2. The card (design_card_agents) already covers the histogram + the
   per-agent {name, status, task-summary, idle-flag, ⇣ws-behind} row
   + orphan footer. The popup is the DRILL: scrollback tail + per-agent
   yank verbs + workspace details. NO duplication of the card's
   summary; the popup assumes the user already saw the card and
   pressed Shift+1 because they want more.

3. SCOPE-CHECK on the brief's `e` (events-filter) and `l` (log-scroll):
   - `e` (events filter) = filter the Activity Log CARD to events from
     this agent. That mutates a sibling card from inside this popup.
     REJECTED for v0: cross-card mutation breaks the card-popup
     pairing rule (each popup owns ONLY its sibling card's slice).
     A user wanting "this agent's events" should press Esc → Shift+4
     (Log popup) and use the Log popup's `/` filter on the agent
     name. The Log popup MAY in v0.next add a verb-keyed yank that
     pre-loads a filter; that's a Log-popup design call, not ours.
   - `l` (log-scroll = jump scrollback to bottom) is redundant with
     the global `G` already in the in-popup convention. Drop.
   - `o` (close) is the brief's straw-man bad mnemonic. Adopt `x`
     (the iface skeleton already uses x, and x reads as "kill" in
     dozens of TUIs — k9s, lazygit, btop). x stays.

4. SCOPE-CHECK on `s` (send a one-line prompt):
   - R1 (model drives the CLI; act-intents YANK, never execute) is
     LOCKED. The popup MUST NOT execute `mu agent send` — even with
     a confirm dialog, that's a pillar break.
   - But "yank a template the user fills in" is fine and useful. The
     `s` verb yanks `mu agent send <name> ''` (single-quoted, empty
     payload). On paste, the user's cursor lands inside the quotes
     and they type the prompt. This is the SAME pattern Git uses for
     `git commit -m ""` — clipboard-friendly templates.
   - Confirmed: `s` for send-template (NOT inspect). Inspect moves
     to the global `y` per the yank-flow lock §7 (Agents popup
     `y` → `mu agent show <name> -w <ws>`); see §VERBS below.

5. SCOPE-CHECK on the `s` / `y` overlap:
   - design_yank_flow §7 LOCKED: in the Agents popup, the global
     `y` yanks `mu agent show <name> -w <ws>` (read-only inspect —
     the universal-safe default). I cannot rebind `y`.
   - That leaves `s` free to mean SEND-TEMPLATE (the verb whose
     mnemonic is "send"). `y` and `s` no longer collide; they
     deliver DIFFERENT yanks for DIFFERENT intents (inspect vs
     send). This is a feature — explicit verb-keys for distinct
     intents, with `y` as the safe default.

6. SCOPE-CHECK on the on-open + per-tick fetch:
   - design_popup_lifecycle locks: onOpen runs ONCE on mount; popup
     tick reuses the same WorkstreamSnapshot the dashboard polls.
     `extra` from onOpen is NOT auto-refreshed.
   - The brief asks for refresh-on-cursor-move (debounced) AND
     refresh-on-tick. That requires a popup-LOCAL effect that is
     NOT part of onOpen. Pattern: keep `extra: { initialScrollback:
     Record<name, string> }` (the on-open one-shot); per-row tail
     happens via a useEffect inside the AgentsPopup component
     watching (focusedName, tickNonce). No contract changes
     needed; it's all popup-local state. See §LAYOUT for details.

7. SCOPE-CHECK on workspace details:
   - `WorkspaceRow.path` is the agent's per-isolated checkout. Users
     COPYING this path to `cd $(...)` is the #1 ask in the
     dogfooding notes. Surfacing it in the popup is high-value.
   - `commitsBehindMain` is already enriched by decorateWithStaleness
     in the dashboard snapshot composer (src/cli/state.ts L120). The
     popup just reads that field; no new SDK call.
   - `dirty?` is NOT yet on WorkspaceRow. Decision: omit dirty for
     v0; surfacing it requires `jj st` / `git status` per agent
     per tick, which is a non-trivial perf cost. Render the popup's
     workspace pane as `path · ⇣N · base=<parentRef>` and document
     that "for dirty-state inspection use `cd $(mu workspace path
     <name>)`". v0.next can add a dirty column if real users ask.

================================================================
DECISION (the contract; copy verbatim into impl_popup_agents)
================================================================

# AgentsPopup (id=1, subject="agents", binds Shift+1 → glyph `!`)

## §LAYOUT

Two-pane split, 25 / 75 (agent-list left / detail right). Both
panes render inside the fullscreen popup chrome (header + body +
footer). NEVER less than 32 cols total — popup is unusable below
that; show "popup too narrow — Esc to return" instead (the same
"hide-card" rule as design_card_agents §COLUMN BUDGET, applied to
the popup as a whole).

```
┌─ Agents [tui]  3 alive · 1 idle · 1 dead     tick 1.0s ─────┐
│ ▸ worker-1   ✦   │ name: worker-1                            │
│   worker-2   ✓   │ status: needs_input  cli: pi  win: agents │
│   reviewer-1 ✓   │ role: read-only                           │
│ ⚠ scout-1   ⚠   │ ws: ~/.local/state/mu/workspaces/tui/     │
│   ✗ ghost-1  ✗   │     scout-1   ⇣4   base=main              │
│                  │                                           │
│                  │ ── pane scrollback (last 100) ────────── │
│                  │ $ cargo test --lib                        │
│                  │   running 312 tests                       │
│                  │   ...                                     │
│                  │   test result: ok. 312 passed.            │
│                  │ pi> (idle, awaiting next prompt)          │
│                  │                                           │
├──────────────────┴───────────────────────────────────────────┤
│ [y] show  [s] send-tmpl  [f] free  [x] close                 │
│ Suggested: y (busy → inspect only)                           │
└─ /=filter  n/N=next/prev  G=tail  ?=help  Esc=close ─────────┘
```

Sizing rules (compose with global popup chrome):
- HEADER row: 1 line. Content: `Agents [<workstream>]  <histogram>`
  + tick-rate indicator on the right. Reuses the same
  agentStatusHistogram helper as the card header.
- LEFT pane: 25% of (width-2) cols, min 22, max 32. Lists every
  agent in attention-bucket sort order (same comparator as
  design_card_agents FINDING #6 — symmetry with the card means the
  user's eye finds the same agent in the same row position). The
  cursor (▸) is the popup-local selection.
- RIGHT pane: remaining width. Vertically split into 4 sections
  (top → bottom):
    1. NAME LINE: bold name, status emoji, idle glyph.
    2. METADATA BLOCK (3 lines): cli + window, role, workspace
       (path · ⇣N · base=<parentRef>).
    3. SCROLLBACK SUBPANE: fills remaining height. Last N lines
       of pane scrollback (default N = min(100, height-9)),
       NEWEST AT BOTTOM (matches `mu agent read` semantics).
       Truncated lines get ASCII ellipsis at the right edge.
       Ink <Static> is NOT used (we want re-render on tick).
    4. NOTES LINK: dim line at the bottom of the right pane:
       "press n for owned-task notes" — REJECTED, see §VERBS;
       replaced with a dim hint "task notes: yank inspect via
       Shift+3 (Tasks popup)". The popup itself does not surface
       task notes (they belong to the Tasks popup; cross-popup
       drill is out of scope per the single-popup invariant).
- FOOTER row: 2 lines. Top = verb tray (`[y] show  [s] send-tmpl
  [f] free  [x] close`) with the SUGGESTED verb prefixed
  "Suggested: <key> (<reason>)" per §SUGGEST below. Bottom = the
  global in-popup nav reminder (/, n/N, G, ?, Esc) — same content
  the help overlay shows; abbreviated here for muscle memory.

Width-reflow:
- width 60..79: drop the verb-tray bracket labels (`y show` →
  `y`); keep the "Suggested:" line.
- width < 60: collapse to single-pane mode (LIST ONLY; the
  detail subpane disappears). Drill happens only at width ≥ 60.
- width < 32: "popup too narrow" placeholder.

Empty state (no agents in this workstream):
- Replaces both panes:
  ```
  No agents in this workstream — `mu agent spawn worker-1 -w tui`
  Press Esc to return.
  ```
- Yank surface SUPPRESSED (verbs no-op with footer toast "no
  agent under cursor"); `y` writes `mu agent spawn worker-1 -w
  tui` to clipboard so the user can paste-and-go.

## §SLICE

```ts
type AgentsSlice = {
  workstreamName: string;     // for command formatting (yank intent)
  view: WorkstreamSnapshot["view"];   // agents + orphans (already
                              //  sorted by attention-bucket via the
                              //  card's comparator; popup REUSES the
                              //  card's sort key for visual symmetry)
  inProgress: TaskRow[];      // for "owned-by" badges in the meta line
  workspaces: WorkspaceRow[]; // for path / parentRef / commitsBehindMain
};

const select = (snap: WorkstreamSnapshot): AgentsSlice => ({
  workstreamName: snap.workstreamName,
  view: snap.view,
  inProgress: snap.inProgress,
  workspaces: snap.workspaces,
});
```

Same shape the card consumes (design_card_agents §SLICE) — the
pairing rule R1 is satisfied; cards and popups for the same
subject share the slice type.

## §EXTRA + ON-OPEN HOOK

```ts
type AgentsPopupExtra = {
  /** Initial pane scrollback per agent. Filled on mount; the
   *  per-row useEffect re-fetches on cursor-move and on tick to
   *  keep the focused agent's view fresh. Untouched names retain
   *  their initial fetch (which becomes stale, but only the
   *  focused agent is rendered, so staleness for the rest is
   *  invisible). Empty-string value means "fetch failed; render
   *  '(scrollback unavailable)' in the right pane". */
  scrollbacks: Record<string /* agent name */, string>;
};

const onOpen = async (db, workstream, snapshot): Promise<AgentsPopupExtra> => {
  const SCROLLBACK_LINES = 100;   // tunable via MU_TUI_AGENTS_POPUP_LINES
  const fetches = snapshot.view.agents.map(async (a) => {
    try {
      const text = await readAgent(db, a.name, {
        workstream,
        lines: SCROLLBACK_LINES,
      });
      return [a.name, text] as const;
    } catch {
      return [a.name, ""] as const;          // tolerant: dead pane returns ""
    }
  });
  const entries = await Promise.all(fetches);
  return { scrollbacks: Object.fromEntries(entries) };
};
```

SDK calls cited (src/agents.ts L566 + src/tmux.ts L829):
- `readAgent(db, name, { workstream, lines: N })` →
  `capturePane(paneId, { lines: N })` → tmux `capture-pane -t
  <pane> -p -S -<N>`. Plain text, no ANSI escapes; safe for ink
  <Text> rendering (no color codes to leak through). Returns ""
  for dead panes (capturePane swallows the missing-target error
  and returns empty per the existing test suite).
- We do NOT call `listLogs` here; per §LAYOUT the activity log is
  out of scope for this popup. Cross-popup drill stays out.

PER-TICK + CURSOR-MOVE REFRESH (popup-local; lives in the
component, NOT in onOpen):
```ts
const focused = agents[focusIdx];
useEffect(() => {
  if (!focused) return;
  let cancelled = false;
  const handle = setTimeout(async () => {     // 150ms debounce
    try {
      const text = await readAgent(db, focused.name, {
        workstream, lines: SCROLLBACK_LINES,
      });
      if (!cancelled) setScrollback((m) => ({ ...m, [focused.name]: text }));
    } catch { /* keep stale */ }
  }, 150);
  return () => { cancelled = true; clearTimeout(handle); };
}, [focused?.name, tickNonce]);
```

Three triggers, one effect:
- onOpen: every visible agent's scrollback is preloaded (so
  arrow-key navigation is instant for the first paint).
- cursor-move (focused.name changes): debounced 150ms, then
  re-fetch the new focused agent.
- per-tick (tickNonce changes — same nonce the dashboard uses
  for poll_loop §1 simple-poll): re-fetch the focused agent.
  This means a busy worker's scrollback auto-tails as it runs.

The non-focused agents' scrollback in `scrollbacks` is allowed
to grow stale; only the focused agent ever paints, so the user
never sees the staleness. On focus change, the effect's first
paint shows the LAST KNOWN text (zero-flash) and the 150ms
debounced re-fetch updates it.

Loading state: while focused agent's entry is undefined OR
empty AND the fetch is in-flight, render `(loading scrollback…)`
in the scrollback subpane. Lifecycle's "Loading…" text rule.

Failure state: empty string from tolerant catch → render
`(scrollback unavailable — pane may be dead; press x to close
the agent)`. Inline, no toast — toasts are for transient
operations; this is a rendered-state issue.

## §VERBS

Reserved-letter pool I may spend: {a b d e f h i l m o p s t u v
x z}. I bind FOUR (the minimum useful set):

| key | label       | act → yank string                         | when relevant     |
| --- | ----------- | ----------------------------------------- | ----------------- |
| `s` | send-tmpl   | `mu agent send <name> '' -w <ws>`         | alive (any)       |
| `f` | free        | `mu agent free <name> -w <ws>`            | alive + idle/busy |
| `x` | close       | `mu agent close <name> -w <ws>`           | dead/orphan       |
|     | (`y` = global yank: `mu agent show <name> -w <ws>`)                      |

Rejected verbs and why:
- `n` (notes): RESERVED globally for filter-next-match; binding
  would shadow per design_global_keymap. To inspect task notes,
  user closes this popup and opens Tasks popup (Shift+3).
- `o` (close): `x` is the canonical "kill" mnemonic in TUIs;
  `o` reads as "open" everywhere else. Adopt `x`. (Brief's
  proposal accepted; `o` stays unbound and free for v0.next.)
- `e` (events filter): cross-popup mutation; rejected (FINDING #3).
- `l` (log-scroll): redundant with global `G`; rejected.
- `a` (adopt orphan): TEMPTING for the orphan-row case but the
  orphan→agent flow is NOT a per-row yank; it's
  `mu agent adopt <pane-id|title>` against a TmuxPane (not an
  AgentRow). Future work: when the cursor is on an orphan row,
  rebind `s/f/x` to no-ops and bind `a` to yank
  `mu agent adopt <pane-title> -w <ws>`. v0 ships orphans as
  read-only rows in the list with an inline hint ("⚠ orphan —
  press a to yank adopt") that does NOTHING; this hint is the
  promotion criterion ("real users hit it ≥2 times" → promote
  the bind). Implementer note: the keymap stays clean for v0
  by NOT registering `a`; the inline hint is documentation-only.

Send-template specifics (the `s` verb):
- The yank string `mu agent send <name> '' -w <ws>` lands in the
  clipboard with the cursor at the closing quote. Per
  design_yank_flow §3-§4, the toast shows "yanked: mu agent send
  worker-1 '' -w tui [copied]" — the user pastes, types between
  the quotes, hits Enter.
- We do NOT prompt for the message inside the popup. That would
  require an in-popup text-input mode (vim's `:` bar pattern),
  which is ~80 LOC of dispatcher carve-outs and breaks the
  in-popup convention's "letter keys are verbs" rule. v0.next.

## §SUGGEST (state-driven verb suggestion line)

The footer's second line reads `Suggested: <key> (<reason>)`
based on the focused agent's state. Pure derivation; no extra
data. The verb tray is unchanged (all four always shown);
SUGGEST is a HINT, not a gate.

```ts
function suggestVerb(a: AgentRow, ownsInProgress: boolean):
  { key: "y" | "s" | "f" | "x"; reason: string }
{
  // Dead pane / orphan → close.
  if (a.status === "dead") return { key: "x", reason: "dead pane → cleanup" };
  // Idle (alive but assigned, no recent progress) → free or send.
  if (a.idle) return { key: "f", reason: "idle → free or s to re-prompt" };
  // Needs-input (agent waiting on operator) → send-template.
  if (a.status === "needs_input")
    return { key: "s", reason: "needs_input → re-prompt" };
  // needs_permission → send-template (operator must supply input).
  if (a.status === "needs_permission")
    return { key: "s", reason: "needs_permission → grant + send" };
  // Busy / running → inspect only.
  if (a.status === "running" || a.status === "busy")
    return { key: "y", reason: "busy → inspect only" };
  // Free / idle-with-no-task → send-template.
  if (a.status === "free")
    return { key: "s", reason: "free → assign next prompt" };
  // Fallback (any future status): inspect.
  return { key: "y", reason: "inspect" };
}
```

Map collapses the brief's table:

| state                | yank intent                                  | verb |
| -------------------- | -------------------------------------------- | ---- |
| alive + idle         | `mu agent send …` OR `mu agent free …`       | f    |
| alive + busy         | `mu agent show …` (read-only)                | y    |
| alive + needs_input  | `mu agent send …` (template)                 | s    |
| alive + needs_perm   | `mu agent send …` (grant + template)         | s    |
| dead / orphan        | `mu agent close …` (cleanup)                 | x    |
| free                 | `mu agent send …` (assign)                   | s    |

Status emoji + colors come from STATUS_EMOJI / STATUS_COLORS in
src/agents.ts L390 + src/cli/format.ts L29-38, same source as
the card. Idle glyph: yellow ⚠ before the status emoji (matches
the card's idle decoration).

The popup does NOT auto-fire the suggested verb on Enter; the
user still presses the explicit key. SUGGEST is purely
hint-text. Avoids the "I pressed Enter and accidentally closed
worker-1" footgun.

## §FILTER

The global `/` filter (incremental, n/N navigation) is honoured
verbatim against the agent list (left pane). Substring match on
agent.name. While filtered, the right pane shows the FIRST
match's detail (cursor jumps to first match on `/`); n/N walk
matches; Enter accepts; Esc cancels filter (NOT popup).

No popup-specific filter override; the global behaviour is
sufficient.

## §EMPTY STATE (re-locked)

When `view.agents.length === 0`:
```
No agents in this workstream — `mu agent spawn worker-1 -w tui`
Press Esc to return.
```
- Replaces both panes (whole popup body).
- `y` yanks the spawn command; toast confirms.
- All other verbs (s/f/x) no-op with footer toast "no agent
  under cursor".
- Workstream name is interpolated from data.workstreamName; if
  the workstream is undefined (defensive), fall back to "<ws>"
  literal.

Symmetry with design_card_agents §COLUMN BUDGET FINDING #7:
identical CTA wording.

## §ORPHANS

Orphan tmux panes (view.orphans) appear at the BOTTOM of the
list, dim-colored, prefixed with `⚠ orphan: `. Cursor CAN focus
them (j/k step through them like agents). When focused:
- Right pane shows the orphan's pane-id, title, and
  `(no managed agent — `mu agent adopt <pane-title>` to register)`.
- Verb tray: `[y] yank-adopt  [s] -  [f] -  [x] -`. Only `y` is
  bound for orphans; it yanks
  `mu agent adopt '<pane-title>' -w <ws>` (single-quoted because
  pane titles may contain spaces).
- This is the ONLY case where `y` yanks something other than
  `mu agent show …`. The dispatcher routes via the popup's `y`
  handler, which inspects the focused row's kind (agent vs
  orphan) before formatting.

(This is the v0 "useful read of orphans" pillar honoured without
binding `a` to a verb — see VERBS table ODDITIES.)

================================================================
TESTS (must-have for v0; lands with impl_popup_agents)
================================================================

In test/cli/tui/popup_agents.test.ts (uses ink-testing-library
+ a mocked tmux executor; the file may not exist yet, blocked
on the devDep landing per design_module_layout ODDITIES — same
gate as the lifecycle tests). Six tests:

1. on-open hook fetches scrollback for every agent in the
   snapshot ONCE.
   - Setup: snapshot with 3 agents; mock readAgent to return
     "AGENT <name> SCROLLBACK".
   - Mount AgentsPopup; await one tick.
   - Assert: readAgent called exactly 3 times (one per agent),
     each with `lines: 100`.

2. cursor-move re-fetches the newly-focused agent (debounced).
   - Setup: same snapshot; on-open completes.
   - Press `j` (move cursor down).
   - Assert: NO immediate readAgent call (within 100ms).
   - Wait 200ms.
   - Assert: readAgent called for the new focused agent exactly
     once.

3. per-tick refresh re-fetches the focused agent.
   - Setup: snapshot; on-open completes; cursor on worker-1.
   - Advance the popup tick once (simulate snapshot delta).
   - Assert: readAgent called for worker-1 exactly once on the
     tick (not for the other agents).

4. SUGGEST line renders the correct verb per state.
   - Table-driven test over the full state→verb table in
     §SUGGEST. For each (status, idle?, ownsInProgress) input,
     mount the popup with that agent focused; assert the footer
     text matches `Suggested: <key> (<reason>)`.

5. verb keypress yanks the correct command.
   - For each of {s, f, x, y}, with worker-1 focused:
     - Press the key.
     - Assert: yank() called with the expected command string
       (the table-form in §VERBS).
     - Assert: toast renders "yanked: <cmd> [copied]" (per
       design_yank_flow §4).

6. empty-state shows the spawn CTA AND `y` yanks it.
   - Setup: snapshot with view.agents = [], view.orphans = [].
   - Mount; assert "No agents in this workstream" rendered;
     assert "press Esc to return" rendered.
   - Press `y`; assert yank() called with
     `mu agent spawn worker-1 -w tui`.

Plus one cross-cut assertion (lives in the keymap test, not
this file): the AgentsPopup's verbs {s, f, x} are subsets of
PopupVerbKey AND no two collide with another popup's verbs OR
with the global in-popup convention. (Designer-1's
design_card_iface §I2 already mandates this test exists; this
note adds AgentsPopup as a concrete fixture.)

================================================================
NEXT
================================================================

- impl_popup_agents (downstream): copies the §LAYOUT + §SLICE +
  §EXTRA + §VERBS + §SUGGEST + §FILTER + §ORPHANS contract
  verbatim. Estimate ~180 LOC for the .tsx + ~140 LOC for the
  test file. Both within the cluster's <300 LOC budget per the
  module-layout cap.
- design_complete (auto-closes via --if-ready once this design
  task closes; that gate fires WHEN every blocked-by here is
  CLOSED).
- v0.next promotion candidates explicitly named in this note
  (each has an inline promotion criterion):
  - bind `a` for orphan-adopt (promote when "real users hit
    the inline hint ≥2 times").
  - in-popup `:` send-prompt prompt-bar (promote when send-
    template paste flow proves clunky in dogfooding).
  - dirty workspace flag in the metadata line (promote when
    real users ask for it; cost = `jj st`/`git status` per
    agent per tick).
  - `e` events-filter that mutates the Log card (promote
    if Log popup's `/` filter-by-name proves insufficient).
  - MU_TUI_AGENTS_POPUP_LINES env var to override the
    SCROLLBACK_LINES default 100 (promote on first user
    request; trivially additive).

================================================================
VERIFIED
================================================================

- Cross-checked against design_locked: read-only (§VERBS yields
  only yanks; no execute path); single-popup invariant (no
  cross-popup nav out of the AgentsPopup); popup close restores
  prior dashboard state (state lives entirely in popup-local
  React; `close()` callback is the lifecycle's restore path);
  in-popup convention preserved (j/k/g/G/n/N/q/y/c/r/w/?/Esc/+
  -/= /0 untouched; verbs only spend the reserved letter pool);
  yank flow A3' surfaces (s/f/x/y all route through
  PopupProps.yank; popup never touches clipboard).

- Cross-checked against design_card_iface §I1-§I4: §LAYOUT does
  not introduce a popup-stack (I1); the cardEnabled state is
  not mutated from inside this popup (I4); yanks overwrite
  saved.footerLine per §I3 (delegated to the global yank flow,
  not this popup's concern); SavedDashboardState shape is
  unaltered (I3 / lifecycle §3).

- Cross-checked against design_popup_lifecycle: onOpen returns
  Promise<AgentsPopupExtra> (§4); render handles
  extra === undefined (§4 loading branch — "(loading
  scrollback…)" placeholder); verb act() callbacks return a
  yank string (no synchronous throw — §VERBS); per-popup state
  (focusIdx, debounce timers, scrollback map) is popup-local
  useState and is LOST on close (lifecycle §3).

- Cross-checked against design_card_agents: same SLICE shape
  (workstreamName, view, inProgress, workspaces) reused; same
  status emoji + idle glyph + STATUS_COLORS; same attention-
  bucket sort comparator (visual symmetry — ROW N in the card
  is ROW N in the popup list).

- Cross-checked against design_yank_flow §7: AgentsPopup `y` →
  `mu agent show <name> -w <ws>` is honoured as the GLOBAL `y`
  default. Verb-keyed yanks (s/f/x) are explicit per-intent
  overrides; orphan-row `y` formats `mu agent adopt …` instead
  (one documented carve-out — §ORPHANS).

- Cross-checked against design_global_keymap: spent letter pool
  is {s, f, x} ⊂ {a b d e f h i l m o p s t u v x z}. Zero
  overlap with the global in-popup verb set
  {j k g G n N q y c r w}. Zero overlap with the digit row or
  the punctuation set used by global controls (+ - = 0 / ? r).
  The unbound letters {a b d e h i l m o p t u v z} stay in
  the pool for sibling popups and v0.next.

- Cross-checked against src/agents.ts: readAgent (L566) takes
  `(db, name, { workstream, lines })` and returns Promise<string>
  via capturePane (src/tmux.ts L829). On a missing pane,
  capturePane returns empty string (not a throw); the on-open
  catch is defensive belt-and-braces.

- Cross-checked against src/agents.ts AgentRow (L82) status
  enum (`needs_input | needs_permission | running | busy |
  free | dead`) plus the derived `idle?: boolean`. Every
  branch in §SUGGEST has a state in this enum (no impossible
  states; the fallback covers v0.next AgentStatus additions).

- Cross-checked against src/workspace.ts WorkspaceRow (L36):
  the metadata block reads `path`, `parentRef`,
  `commitsBehindMain`. All present and decorated by
  decorateWithStaleness in the snapshot composer
  (src/cli/state.ts L120). No new SDK call.

- Cross-checked against the ROADMAP <300 LOC promotion bar:
  estimated impl_popup_agents .tsx ~180 LOC + test file ~140
  LOC ≈ 320 LOC. Squeak over by ~20; tolerable. The popup is
  the second-most-complex of the four (after Tasks); within
  the per-cluster budget envelope (~1450 total per
  design_module_layout).

================================================================
ODDITIES
================================================================

- The "press n for owned-task notes" link the brief asked for
  is REJECTED. `n` is a global filter-next-match; binding it
  here shadows the convention. Cross-popup drill (Agents popup
  → Tasks popup pre-focused on this agent's tasks) would
  require either (a) a popup-stack (rejected by the single-
  popup invariant), or (b) a "next popup hint" parameter to
  the close callback (premature; only one consumer would exist
  in v0). The chosen workaround — a dim hint in the right pane
  pointing to Shift+3 — is honest about the v0 capability.
  Promotion: if real users hit "I want to drill from agent to
  this agent's tasks" ≥2 times, design a "popup-stack-of-1"
  carve-out then.

- The brief's `e` (events filter) and `l` (log scroll) verbs
  are REJECTED with reasoning in FINDING #3. The Log popup
  (Shift+4) is the right place for filtering events; this
  popup intentionally does not duplicate that surface.

- SCROLLBACK_LINES = 100 is a heuristic. tmux pane history is
  capped at the user's `history-limit` (default 2000). 100 is
  ~enough to see one test run's tail without overflowing a
  screen at typical terminal heights (40-50 rows). If users
  ask for "show me the full scrollback" we add an in-popup
  `<` / `>` half-page scroll AND/OR an MU_TUI_AGENTS_POPUP_LINES
  env. v0.next; documented in NEXT.

- The per-tick re-fetch (§EXTRA + ON-OPEN HOOK) calls
  `readAgent` from inside an ink useEffect, which means it
  shells out to tmux every 1s by default. tmux capture-pane
  is fast (sub-millisecond on local sessions). NOT a perf
  concern at v0; if it ever shows up in `mu doctor` profiling
  we can throttle to 2s when the focused agent's status is
  stable. Documented for future-self.

- The non-focused agents' scrollback in `extra.scrollbacks`
  becomes stale within seconds of opening the popup. We don't
  evict it because the user MAY arrow back to a previously-
  focused agent and the stale text is BETTER than a
  "(loading…)" flash. The 150ms debounced re-fetch on cursor-
  move catches the staleness within one frame for the user's
  current focus. This is the lifecycle §4 "no extra cache"
  guidance: the scrollback IS the extra cache, intentionally
  ungoverned.

- The ASCII-only fallback for the popup chrome (the box-
  drawing characters in §LAYOUT are decorative; ink renders
  them with no font dependency) means non-Nerd-Font users
  still see a coherent layout. Status glyphs (✓ ✦ ⚠ ✗) come
  from the existing STATUS_EMOJI which assumes Nerd Fonts —
  this is consistent with the card's assumption (same
  failure mode if the user lacks Nerd Fonts; same resolution
  — out of scope for the popup).

- The orphan-row `y` carve-out (yanks `mu agent adopt …`
  instead of `mu agent show …`) is the ONLY in-popup
  conditional yank in v0. design_yank_flow §7's "Agents popup
  `y` → `mu agent show <name>`" lock is preserved by
  reading: the orphan row is NOT an "agent" — it's a tmux
  pane the snapshot exposes alongside agents. The yank lock
  applies to AgentRow yanks; orphans get their own. Both
  formats live in the popup's `y` handler dispatch. The
  yank-flow note's lock language ("Agents popup `y` →
  `mu agent show <name> -w <ws>`") MAY be re-read as
  underspecified for the orphan case; this note formalises
  it. If a stricter reading is preferred, drop the orphan-row
  `y` carve-out and require the user to type the adopt
  command from the inline hint — but then the popup's
  read-of-orphans pillar is weaker.

- We do NOT render the agent's CURRENTLY OWNED IN-PROGRESS
  tasks in the right pane's metadata block. The card already
  shows that ("task" column with summarizeOwnedTasks).
  Repeating it in the popup is glanceable-data-on-drill —
  pointless. Saved 2 lines of vertical space for
  scrollback. If users ask "what's worker-1 doing" the
  scrollback IS the answer; the task ID (already in the card)
  is one Esc + glance away.

- The popup's tickNonce reuses the dashboard's poll_loop §1
  nonce so the snapshot AND the focused-agent scrollback
  refresh on the SAME cadence. This means changing tick
  rate via + / - / = / 0 LIVE inside the popup ALSO changes
  the scrollback re-fetch cadence. That's by design and
  matches the lifecycle §5 "popup tick: same as dashboard"
  lock; calling it out so the implementer doesn't add a
  separate tick-controller for the scrollback fetch.
````

### #2 by "designer-2", 2026-05-11T11:31:25.726Z

```
CLOSE: Agents popup design done; LAST design task closed
```
