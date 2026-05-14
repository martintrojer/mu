---
id: "design_card_agents"
workstream: "tui"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: "scout-1"
created_at: "2026-05-11T10:45:06.950Z"
updated_at: "2026-05-11T11:17:07.562Z"
blocked_by: ["design_card_iface"]
blocks: ["design_complete", "design_popup_agents"]
---

# Design Agents card: summary table (name/status/task/idle/ws-behind)

## Notes (2)

### #1 by "scout-1", 2026-05-11T11:17:05.467Z

````
FILES:
- (read-only; design-only — output is this note)
- read: src/cli/state.ts L538-593 (formatHudAgentsTable — to be deleted)
- read: src/cli/state.ts L734-741 (agentStatusHistogram — to be lifted to src/state.ts per design_sdk_seam #7)
- read: src/agents.ts L82-111  (AgentRow shape; idle? derived flag)
- read: src/agents.ts L386-398 (STATUS_EMOJI nf-glyph map; single source of truth)
- read: src/cli/format.ts L29-50 (STATUS_COLORS, statusIcon, IDLE_GLYPH = "⚠")
- read: src/detect.ts L26-33   (AgentStatus enum: 7 values)
- read: src/workspace.ts L36-50 (WorkspaceRow.commitsBehindMain — null/undefined semantics)
- read: mu task notes design_locked / design_card_iface / design_poll_loop / design_sdk_seam / audit_state_ts -w tui

COMMANDS:
- mu task notes {design_locked, design_card_iface, design_poll_loop, design_sdk_seam, audit_state_ts} -w tui
- mu task show design_card_agents -w tui
- (zero shell mutations; design-only; ~30 min)

FINDINGS:

1. CONTRACT INHERITED. design_card_iface fixed:
     export interface Card<TSlice> {
       id: 1..9; subject: string; label: string;
       select: (snap: WorkstreamSnapshot) => TSlice;
       minWidth: number; minHeight: number;
       render: ComponentType<CardProps<TSlice>>;
     }
   AgentsCard's job is: pick id, label, slice, minWidth/minHeight, layout.
   Sample in design_card_iface already names it AgentsCard with id=1,
   subject="agents", label="Agents", slice = { view: snap.view }. That
   wins. Don't relitigate.

2. SDK SEAM INHERITED. design_sdk_seam #7/#8 defines:
     agentStatusHistogram(agents): ReadonlyMap<AgentStatus, number>  (pure)
     summarizeOwnedTasks(owned: TaskRow[]): { bit, count, onlyTaskId? }
   The audit (audit_state_ts L142-146) recommends folding "in-progress
   count + owners" INTO the Agents card rather than a 5th card. The TUI
   already gets `inProgress: TaskRow[]` in WorkstreamSnapshot, so the
   row's task column is fed by:
     summarizeOwnedTasks(snap.inProgress.filter(t => t.ownerName === a.name))
   No DB call per agent (the static path's `listTasksByOwner(...)` per row
   in cli/state.ts L555-557 was an N+1 we don't need to inherit).

3. ORPHAN COVERAGE. audit_state_ts L136-141 says fold orphans into the
   Agents card. The slice already includes `view.orphans` (TmuxPane[]).
   On the dashboard we render them as a single dim footer line under the
   table ("⚠ N orphan panes — Shift+1 to inspect"). Full orphan rows live
   in the popup (design_popup_agents). Card stays glanceable.

4. STATUS GLYPH PARITY. STATUS_EMOJI is canonical (src/agents.ts L390):
     spawning  \uf251 (hourglass)
     busy      \uf013 (cog)
     needs_input      \uf186 (moon)
     needs_permission \uf023 (lock)
     free      \uf058 (check_circle)
     unreachable      \uf059 (question_circle)
     terminated       \uf057 (times_circle)
   STATUS_COLORS (src/cli/format.ts L29-38) is canonical:
     spawning yellow · busy cyan · needs_input dim · needs_permission
     magenta · free green · unreachable red · terminated dim
   IDLE_GLYPH = "⚠" plain Unicode (yellow), prepended to status cell when
   AgentRow.idle === true (matches static fallback at cli/state.ts L580-583).
   The card MUST consume STATUS_EMOJI + STATUS_COLORS unmodified — we DO
   NOT fork iconography or pick "TUI-friendly" alternates. Two-source-of-
   truth review (review_code_status_emoji_two_sources cited in
   src/cli/format.ts L34-37) is the cautionary tale.

5. IDLE THRESHOLD. AgentRow.idle is already derived inside listLiveAgents
   per src/agents.ts L102-110 against MU_IDLE_THRESHOLD_MS (default 300_000ms
   = 5 min). The card just READS the boolean — it does NOT recompute. The
   "⚠ N min" text is `relTime(now - new Date(a.updatedAt).getTime())`
   prefixed with the IDLE_GLYPH. relTime lives in cli/format.ts and is
   already used by the static path; reuse, don't reimplement.

6. WORKSPACE-BEHIND. WorkspaceRow.commitsBehindMain is `number | null |
   undefined`. The slice MUST include `snap.workspaces` so the card can
   join agents → workspaces by `agentName`. Column shows "⇣N" only when
   `n > 0` (yellow when n >= STALE_THRESHOLD = 10, dim "⇣N" otherwise);
   "—" for n === 0; "?" dim for null/undefined (not yet computed / no
   workspace). This matches the static path's stale-threshold semantics
   (cli/state.ts L349-354) without rendering the workspace path or full
   diff numbers — that's popup territory.

7. SORT. The static formatHudAgentsTable inherits whatever order
   listLiveAgents returns (insertion / row-id order in agents table),
   which is essentially "spawn order". For a glanceable card I want
   THINGS-DEMANDING-ATTENTION at the TOP. Two-key sort:
     primary:  attention bucket DESC — needs_permission (4) > needs_input
               (3) > idle? (2) > busy/spawning (1) > free/terminated/
               unreachable (0)
     secondary: name ASC (lexical, deterministic)
   Rationale: needs_permission is the pi auto-accept-blocked state;
   needs_input is "pi finished and is waiting"; idle is "needs_input AND
   has unfinished tasks AND stale"; busy/spawning are routine; terminal
   states sink. Alphabetical secondary keeps the order STABLE between
   ticks (no flicker). Most-recently-active was considered and rejected
   — updatedAt churns every tick (status-only reconcile bumps it), which
   would re-order the table on every poll.

8. EMPTY STATE. "No agents yet — `mu agent spawn worker-1 -w <ws>`" with
   the workstream name interpolated from `snap.workstreamName` (yes, the
   slice needs that; see DECISION below). Use pc.dim equivalent in ink
   (`<Text dimColor>`).

9. minWidth / minHeight: design_card_iface defaults are 40 cols × 4 rows
   for tight cards. A row needs:
     name (≤16) │ status (3) │ task (≤16) │ idle (≤9) │ ⇣N (3) ≈ 47 cols
     + 4 col-separators × 1 col = 51 cols
   Realistic minWidth = 44 (collapse idle column to "⚠" only and ws-
   behind to "⇣" when width < 50). MinHeight = 5 (1 header + 1 hist row +
   2 agent rows + 1 footer for orphans). On terminals shorter than this
   the card auto-hides per Card.minHeight contract.

DECISION:

================================================================
AGENTS CARD — id=1, subject="agents", label="Agents"
================================================================

```ts
// src/cli/tui/cards/agents.tsx
import type { FC } from "react";
import { Box, Text } from "ink";
import type { Card, CardProps } from "../types.js";
import type { LiveAgentsView } from "../../../agents.js";
import type { TaskRow } from "../../../tasks.js";
import type { WorkspaceRow } from "../../../workspace.js";
import {
  agentStatusHistogram,
  summarizeOwnedTasks,
} from "../../../state.js";              // promoted per design_sdk_seam
import { STATUS_EMOJI } from "../../../agents.js";
import { STATUS_COLORS, IDLE_GLYPH, relTime } from "../../format.js";

export interface AgentsCardSlice {
  workstreamName: string;            // for empty-state CTA
  view: LiveAgentsView;              // .agents + .orphans
  inProgress: readonly TaskRow[];    // for summarizeOwnedTasks
  workspaces: readonly WorkspaceRow[]; // for ws-behind join by agentName
}

const AGENT_ATTENTION_RANK: Record<AgentStatus, number> = {
  needs_permission: 4,
  needs_input:      3,
  busy:             1,
  spawning:         1,
  free:             0,
  unreachable:      0,
  terminated:       0,
};

export const AgentsCard: Card<AgentsCardSlice> = {
  id: 1,
  subject: "agents",
  label: "Agents",
  minWidth: 44,
  minHeight: 5,
  select: (snap) => ({
    workstreamName: snap.workstreamName,
    view: snap.view,
    inProgress: snap.inProgress,
    workspaces: snap.workspaces,
  }),
  render: AgentsCardComponent,
};

const AgentsCardComponent: FC<CardProps<AgentsCardSlice>> = ({
  data,
  width,
  height,
}) => { /* layout below */ };
```

================================================================
LAYOUT (top-to-bottom; ink Box vertical)
================================================================

Row 0 — HEADER (1 row):
    ▎Agents · {hist}                   (hint right-aligned)
  where {hist} is rendered from agentStatusHistogram(view.agents):
    Map → "<statusIcon(s)>{count}" joined with " "  (e.g. "✓3 ⚙1 ⚠1")
  hint = pc.dim("Shift+1 popup")  — only shown if width >= 60.
  When agents.length === 0: header = pc.dim("Agents · empty").

Row 1 — TABLE HEAD (1 row, dim):
    name              status   task             idle     ⇣
  Always rendered (so the table reads as a table even when empty).
  Column widths reflow: see budget calc below.

Rows 2..N — ONE ROW PER AGENT (sorted per FINDING #7):
    {nameCell} {statusCell} {taskCell} {idleCell} {wsCell}

  statusCell = idle?
      `${chalk.yellow(IDLE_GLYPH)} ${STATUS_COLORS[s](STATUS_EMOJI[s])}`
    : `  ${STATUS_COLORS[s](STATUS_EMOJI[s])}`;
  // The `  ` (two-space) padding is critical so columns align between
  // idle and non-idle rows. statusW budget = 4.

  nameCell = idle ? <Text color="yellow">{a.name}</Text>
                  : <Text bold>{a.name}</Text>;

  taskCell = (() => {
    const owned = inProgress.filter(t => t.ownerName === a.name);
    const sum = summarizeOwnedTasks(owned);          // {bit, count, onlyTaskId?}
    if (sum.count === 0) return <Text dimColor>—</Text>;
    if (sum.count === 1) return <Text color="cyan">{sum.bit}</Text>;
    return <Text dimColor>{sum.bit}</Text>;          // "⊕N"
  })();

  idleCell = idle
    ? <Text color="yellow">{`${IDLE_GLYPH} ${relTime(now - updated)}`}</Text>
    : <Text dimColor>—</Text>;

  wsCell = (() => {
    const ws = workspaces.find(w => w.agentName === a.name);
    const n = ws?.commitsBehindMain;
    if (n == null) return <Text dimColor>?</Text>;   // null|undefined
    if (n === 0)   return <Text dimColor>—</Text>;
    if (n >= 10)   return <Text color="yellow">{`⇣${n}`}</Text>;
    return <Text dimColor>{`⇣${n}`}</Text>;
  })();

Row N+1 — ORPHAN FOOTER (0 or 1 row):
  if (view.orphans.length > 0)
    <Text dimColor>{`⚠ ${view.orphans.length} orphan pane${
      view.orphans.length === 1 ? "" : "s"} — Shift+1 to inspect`}</Text>

Empty-state SUBSTITUTION (replaces rows 1..N+1 entirely):
  <Text dimColor>{
    `No agents yet — \`mu agent spawn worker-1 -w ${workstreamName}\``
  }</Text>

================================================================
COLUMN BUDGET (width-reflow rule)
================================================================

Fixed costs:
  status  = 4   (idle prefix + glyph)
  inter-col separators = 4 × 1 col = 4

Variable widths (computed from data, like the static path L546-562):
  nameW = max(4, max(a.name.length))             clamp ≤ 24
  idleW = idle? "⚠ Nm/Nh" — clamp ≤ 9 ; or "—"
  wsW   = "?", "—", or "⇣N" (N up to 4 digits) — clamp ≤ 5

  taskBudget = max(8, width - status - nameW - idleW - wsW - 4)
             // remainder column; truncate task bit to fit

When width < 60: drop the "idle" column header text but keep the cell
(as just "⚠" or "—" — no relTime). When width < 50: drop the wsCell
column entirely (no ws-behind on the card). Both cases: the popup still
shows them.

Rendering: use ink's <Box flexDirection="row"> with each cell wrapped in
a <Box width={n}>. NOT cli-table3 — we're inside ink now (design_locked
amends the "no render layer beyond cli-table3 + picocolors" pillar).

================================================================
RECOMMENDED ANSWERS TO BRIEF QUESTIONS
================================================================

(1) Per-row columns: name | status | task | idle | ⇣ws-behind  ✓ adopt
    the brief's default. taskCell uses summarizeOwnedTasks; "⊕N" dim,
    single-task name cyan, "—" dim (matches static L561-562).

(2) Header histogram: ADOPT agentStatusHistogram in the card header.
    Render as compact "icon{n} icon{n} ..." (no commas, single space
    separator). Parens form ("3 ✓ alive · 1 ⚠ idle") rejected — too
    chatty for a single header cell, and wraps badly < 60 cols. The
    glyph+count form fits in ~12 cols typical.

(3) Status emoji set: USE STATUS_EMOJI + STATUS_COLORS verbatim from
    src/agents.ts L390 + src/cli/format.ts L29-38. SAME glyphs as static.
    DO NOT define a TUI-local alternate map.

(4) Idle column: USE AgentRow.idle (already gated by MU_IDLE_THRESHOLD_MS
    inside listLiveAgents). Show "⚠ {relTime(updatedAt)}" yellow when
    true; "—" dim otherwise. Confirmed.

(5) Workspace-behind: "⇣N" with yellow ≥10 / dim 1..9 / "—" if 0 / "?"
    if null/undefined. NEVER render workspace.path on the card. Confirmed.

(6) Sort: attention-bucket DESC, then name ASC. Stable across ticks.
    Recommended over alphabetical (alphabetical buries the worker that
    needs your attention behind 5 free workers) and over most-recent
    (updatedAt churns every poll → flicker).

(7) Empty state: "No agents yet — `mu agent spawn worker-1 -w {ws}`"
    with the workstream name interpolated. Replaces table body, not
    header.

(8) Colour: STATUS_COLORS for status glyph; yellow for idle / staleness
    / orphan footer; cyan for single-task names; dim for placeholders /
    multi-task counts / orphan count. ink's <Text color="..."> +
    dimColor; the picocolors → ink mapping is direct (yellow→"yellow",
    cyan→"cyan", red→"red", magenta→"magenta", green→"green",
    pc.dim→<Text dimColor>, pc.bold→<Text bold>).

(9) minWidth=44, minHeight=5.

(10) Card vs Popup split:
       CARD shows: histogram, ≤N rows of {name, status, task summary,
         idle flag, ws-behind count}, orphan-footer count.
       POPUP shows (out of scope here, see design_popup_agents):
         - per-agent pane scrollback drill (Popup.onOpen tmux capture)
         - workspace path / full commits-behind / parent_ref
         - orphan rows enumerated with adopt CTA
         - per-agent verbs (s=show, f=free, x=close — yank-only per R1)
     The CARD is glanceable. If you find yourself adding a column for
     "what would be nice in the popup", STOP and add it to
     design_popup_agents instead.

NEXT:
- design_popup_agents (sibling): consume the same slice + onOpen-fetched
  scrollbacks; verbs s/f/x from the reserved letter pool.
- Implementation gate (post all design_card_*): add unit tests for
  (a) sort stability across ticks with same input,
  (b) summarizeOwnedTasks integration on a 0/1/N owner case,
  (c) empty-state CTA includes the resolved workstream name,
  (d) ws-behind joins on agentName (not pane id) and tolerates the
      "agent has no workspace" case → "?".

VERIFIED:
- Cross-checked against design_card_iface: id=1 + subject="agents" +
  the named slice match the sample in §1 of that contract; minWidth/
  minHeight fields are present and motivated (FINDING #9).
- Cross-checked against design_sdk_seam: AgentsCardSlice consumes only
  fields of WorkstreamSnapshot (workstreamName, view, inProgress,
  workspaces). No new SDK type invented. summarizeOwnedTasks +
  agentStatusHistogram are the helpers the seam already promotes.
- Cross-checked against design_locked: ink-only (no cli-table3 inside
  the card); read-only (no act-intent on the card — popup owns yank
  verbs); single-popup invariant unaffected (card has no internal
  selection state).
- Cross-checked against design_poll_loop: select() is pure; no useState/
  useEffect at the registry level; re-renders driven by snapshot delta
  per the F1 simple-poll contract (poll_loop §1). Toggle-on
  refresh-now path is unaffected (the card has nothing card-local to
  invalidate; everything comes from the snapshot).
- Cross-checked against audit_state_ts: covers the "fold orphans into
  Agents card" recommendation (FINDING #3) and the "in-progress count +
  owners as a card row, not a 5th card" recommendation (FINDING #2).
  Workspaces remain a separate concern (audit's recommended v0.1 5th
  card or accept regression — out of scope here; the card surfaces only
  the per-agent ⇣N digest).
- Cross-checked against src/agents.ts STATUS_EMOJI + src/cli/format.ts
  STATUS_COLORS / IDLE_GLYPH: the card consumes those imports verbatim
  (FINDING #4). The single-source-of-truth review-finding (review_code_
  status_emoji_two_sources) is honoured.

ODDITIES:
- The slice asks for `workstreamName` in addition to view/inProgress/
  workspaces. design_card_iface's sample slice was just `{ view }` for
  brevity; the empty-state CTA requires the workstream name. This is
  WITHIN the contract — the slice is whatever the card needs from the
  snapshot — and adds zero rows to the SDK. Flagging because the iface
  sample looks like the canonical AgentsCard and a copy-paster might
  miss it.
- summarizeOwnedTasks per the seam takes `readonly TaskRow[]` and the
  CARD does the .filter(t => t.ownerName === a.name) per row. That's
  O(agents × inProgress) = O(N²) on tiny N (typical wave: <10 agents,
  <30 in-progress tasks → 300 ops). If a wave ever grows to triple
  digits we can pre-bucket once per tick into Map<owner, TaskRow[]>;
  not premature now. Documented for future-self.
- The AGENT_ATTENTION_RANK constant is card-local. It was tempting to
  promote it to src/state.ts as a sorter helper, but: (a) only this
  card has an opinion on agent priority; the popup uses spawn order.
  (b) Promoting it would force every consumer to inherit our opinion.
  Keep it local; revisit if a second consumer appears.
- The "⇣" arrow we use for commits-behind matches jujutsu's `jj log`
  glyph for "behind", which is what most operators of this repo will
  recognise. ASCII fallback would be "<N" but mu's substrate already
  assumes Nerd Fonts (see src/agents.ts L385-389 banner) so plain
  Unicode "⇣" is fine — same fallback story as IDLE_GLYPH "⚠".
- AgentStatus has 7 values; the histogram MAY render up to 7 cells.
  At width < 30 cols this overflows. The header is responsible for
  truncating: if histogram render width > headerCellBudget, drop the
  zero-count entries first (which we already do — we only set keys
  with n>0), then truncate the rendered string with an ellipsis.
  Implementation note for the per-card .tsx; not a contract.
- The ATTENTION_RANK gives needs_permission > needs_input. Reasoning:
  needs_permission means pi is BLOCKED on operator action (the agent
  literally cannot proceed); needs_input often means pi finished its
  last instruction and is awaiting next-task (less acute). The static
  path doesn't sort, so this is a TUI-only opinion — flagged because
  reviewers may want to invert.
````

### #2 by "scout-1", 2026-05-11T11:17:07.562Z

```
CLOSE: Agents CARD design done
```
