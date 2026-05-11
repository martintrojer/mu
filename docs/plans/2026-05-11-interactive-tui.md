# Implementation Plan: Interactive TUI (replaces `mu state --hud`)

**Date:** 2026-05-11
**Design Doc:** workstream `tui` in mu's task DAG. Run `mu task notes <id> -w tui` for any referenced task to read the design rationale verbatim. Closed umbrella: `design_complete`.
**Estimated Tasks:** 78
**Estimated Total Time:** ~10–14 hours of focused implementation work

## Overview

Replace `mu state --hud` with an interactive `ink`-based TUI invoked by bare `mu state` (or just `mu`) when stdout is a TTY. Read-only (model drives the CLI; act-intents `y`-yank `mu …` commands rather than executing them). Four glance-cards on the dashboard (Agents / Tracks / Ready / Activity log) toggleable with `1`–`4`; matching fullscreen popups opened with `Shift+1`–`Shift+4` (US-glyph-row bound: `!`/`@`/`#`/`$`). Ships ink + react as new deps under a tightened pledge that confines them to `src/cli/tui/`.

This plan is divided into 9 ordered waves. Each wave's tasks may be parallelized internally; waves themselves are sequential because each depends on the previous wave's output. **Run `npm run typecheck && npm run lint && npm run test && npm run build` before committing each task.**

---

## Wave 1: Foundations (deps, tsconfig, scaffold)

Goal: green build with empty TUI files in place.

### Task 1: Add ink + react dependencies
**File:** `package.json`
**Time:** ~3 min

**Steps:**
1. Add `"ink": "^5.0.0"` and `"react": "^18.0.0"` under `"dependencies"`.
2. Add `"@types/react": "^18.0.0"` under `"devDependencies"`.
3. Run `npm install`.

**Verify:**
```bash
node -e "import('ink').then(m => console.log('ink loaded'))"
node -e "import('react').then(m => console.log('react loaded'))"
```

**Commit:** `deps: add ink + react for TUI subtree`

---

### Task 2: Enable JSX in tsconfig
**File:** `tsconfig.json`
**Time:** ~2 min

**Steps:**
1. Under `"compilerOptions"` add `"jsx": "react-jsx"` and `"jsxImportSource": "react"`.

**Verify:**
```bash
npm run typecheck
```

**Commit:** `tsconfig: enable react-jsx automatic runtime`

---

### Task 3: Create `src/cli/tui/` scaffold (empty files)
**Files:** Create the 14-file cluster with placeholder content so the next tasks can fill them in without break-on-each-task ordering pain.
**Time:** ~5 min

**Steps:** create each file with the minimal valid placeholder shown.

```bash
mkdir -p src/cli/tui/cards src/cli/tui/popups
```

```ts
// src/cli/tui/index.ts
import type { Db } from "../../db.js";
import type { StateOpts } from "../state.js";
export async function runTui(_db: Db, _opts: StateOpts): Promise<void> {
  throw new Error("runTui: not implemented yet");
}
```

```ts
// src/cli/tui/state.ts
export const TUI_PLACEHOLDER = true;
```

```ts
// src/cli/tui/keys.ts
export const KEYS_PLACEHOLDER = true;
```

```ts
// src/cli/tui/yank.ts
export const YANK_PLACEHOLDER = true;
```

```tsx
// src/cli/tui/app.tsx
import { Text } from "ink";
export function App(): JSX.Element { return <Text>tui placeholder</Text>; }
```

```tsx
// src/cli/tui/help.tsx
import { Text } from "ink";
export function Help(): JSX.Element { return <Text>help placeholder</Text>; }
```

For each card and popup, create a placeholder:

```tsx
// src/cli/tui/cards/agents.tsx (and tracks.tsx, ready.tsx, log.tsx)
import { Text } from "ink";
export function AgentsCard(): JSX.Element { return <Text>agents card placeholder</Text>; }
```

```tsx
// src/cli/tui/popups/agents.tsx (and tracks.tsx, ready.tsx, log.tsx)
import { Text } from "ink";
export function AgentsPopup(): JSX.Element { return <Text>agents popup placeholder</Text>; }
```

(Use the appropriate component name per file: `TracksCard`, `ReadyCard`, `LogCard`, `TracksPopup`, `ReadyPopup`, `LogPopup`.)

**Verify:**
```bash
npm run typecheck && npm run build
```

**Commit:** `tui: scaffold src/cli/tui/ cluster (14 placeholder files)`

---

### Task 4: Update `biome.json` to handle JSX (if needed)
**File:** `biome.json`
**Time:** ~3 min

**Steps:**
1. Run `npm run lint` and observe any JSX-related rule violations from the placeholders.
2. If violations appear, add the minimal rule overrides to silence them under `"linter": { "rules": { ... } }` or use `"overrides"` to scope rules to `src/cli/tui/**/*.tsx`.
3. If no violations: skip this task.

**Verify:**
```bash
npm run lint
```

**Commit:** `biome: scope JSX-friendly rules to src/cli/tui/**/*.tsx` (if changed)

---

## Wave 2: SDK seam (`src/state.ts`)

Goal: extract pure data helpers from `src/cli/state.ts` per `design_sdk_seam` so both static and TUI consume them.

### Task 5: Add `WorkstreamSnapshot` type + `loadWorkstreamSnapshot`
**File:** `src/state.ts` (new file, ~150 LOC budget)
**Time:** ~10 min

**Steps:**
1. Read `src/cli/state.ts` lines 93–139 (current `PerWsData` + `loadWorkstreamData`).
2. Create `src/state.ts` and export:
   - `interface WorkstreamSnapshot` mirroring `PerWsData` field-for-field.
   - `interface LoadWorkstreamSnapshotOptions { eventLimit?: number }`.
   - `function loadWorkstreamSnapshot(db, workstream, opts?): WorkstreamSnapshot` — verbatim port of `loadWorkstreamData` body, accepting `opts.eventLimit` (default 200).
3. Read full design at `mu task notes design_sdk_seam -w tui` for field list.

**Verify:**
```bash
npm run typecheck
```

**Commit:** `state: extract WorkstreamSnapshot + loadWorkstreamSnapshot SDK seam`

---

### Task 6: Move `resolveWorkstreamSet` to `src/state.ts`
**File:** `src/state.ts`, `src/cli/state.ts`
**Time:** ~5 min

**Steps:**
1. Lift `resolveWorkstreamSet` (`src/cli/state.ts:141-194`) into `src/state.ts`. Export with `interface WorkstreamSetOptions { workstream?: string; all?: boolean }`.
2. In `src/cli/state.ts`, remove the function body and add `import { resolveWorkstreamSet } from "../state.js"`.

**Verify:**
```bash
npm run typecheck && npm run lint
```

**Commit:** `state: move resolveWorkstreamSet to src/state.ts`

---

### Task 7: Add `agentStatusHistogram` to `src/state.ts`
**File:** `src/state.ts`, `src/cli/state.ts`
**Time:** ~5 min

**Steps:**
1. Lift `src/cli/state.ts:734-741` body (drop `pc.*` / `parts.join`).
2. Export `function agentStatusHistogram(agents: readonly AgentRow[]): ReadonlyMap<AgentStatus, number>`.
3. Update existing static `mu state` Agents header (`src/cli/state.ts` ~L320) to call this helper if convenient (optional in this task; static-side adoption can come later).

**Verify:**
```bash
npm run typecheck && npm run test
```

**Commit:** `state: extract agentStatusHistogram helper`

---

### Task 8: Add `summarizeOwnedTasks` to `src/state.ts`
**File:** `src/state.ts`
**Time:** ~5 min

**Steps:**
1. Add per the design:
   ```ts
   export interface OwnedTasksSummary {
     bit: string;
     count: number;
     onlyTaskId?: string;
   }
   export function summarizeOwnedTasks(owned: readonly TaskRow[]): OwnedTasksSummary {
     const count = owned.length;
     if (count === 0) return { bit: "—", count: 0 };
     if (count === 1) {
       const only = owned[0];
       if (!only) return { bit: "—", count: 0 };
       return { bit: only.name, count: 1, onlyTaskId: only.name };
     }
     return { bit: `⊕${count}`, count };
   }
   ```

**Verify:**
```bash
npm run typecheck
```

**Commit:** `state: extract summarizeOwnedTasks helper`

---

### Task 9: Add `roiBucket` to `src/state.ts`
**File:** `src/state.ts`
**Time:** ~3 min

**Steps:**
1. Add:
   ```ts
   export type RoiBucket = "high" | "mid" | "low" | "infinite";
   export function roiBucket(impact: number, effortDays: number): RoiBucket {
     const r = effortDays > 0 ? impact / effortDays : Infinity;
     if (!Number.isFinite(r)) return "infinite";
     if (r >= 100) return "high";
     if (r >= 50) return "mid";
     return "low";
   }
   ```

**Verify:**
```bash
npm run typecheck
```

**Commit:** `state: extract roiBucket helper`

---

### Task 10: Add `classifyEventVerb` to `src/logs.ts`
**File:** `src/logs.ts`
**Time:** ~5 min

**Steps:**
1. Read `src/cli/state.ts:677-686` (current `colorEventPayload`).
2. Lift the prefix-matching logic (drop the `pc.cyan` call) into `src/logs.ts` next to `EVENT_VERB_PREFIXES`:
   ```ts
   export interface ClassifiedEvent { verb: string; rest: string; }
   export function classifyEventVerb(payload: string): ClassifiedEvent | null {
     for (const verb of EVENT_VERB_PREFIXES) {
       if (!payload.startsWith(verb)) continue;
       const next = payload.charAt(verb.length);
       if (next !== "" && next !== " " && next !== "\t") continue;
       return { verb, rest: payload.slice(verb.length) };
     }
     return null;
   }
   ```

**Verify:**
```bash
npm run typecheck && npm run test
```

**Commit:** `logs: extract classifyEventVerb (sibling of EVENT_VERB_PREFIXES)`

---

### Task 11: Re-export new helpers from `src/index.ts`
**File:** `src/index.ts`
**Time:** ~3 min

**Steps:** add re-exports for `WorkstreamSnapshot`, `loadWorkstreamSnapshot`, `WorkstreamSetOptions`, `resolveWorkstreamSet`, `agentStatusHistogram`, `summarizeOwnedTasks`, `OwnedTasksSummary`, `roiBucket`, `RoiBucket`, `ClassifiedEvent`, `classifyEventVerb`.

**Verify:**
```bash
npm run typecheck && npm run build
```

**Commit:** `sdk: re-export TUI seam helpers from src/index.ts`

---

### Task 12: Add unit tests for new SDK helpers
**File:** `test/state-helpers.test.ts` (new)
**Time:** ~10 min

**Steps:** TDD-style — assert each helper:
- `summarizeOwnedTasks([])` → `{ bit: "—", count: 0 }`
- `summarizeOwnedTasks([{name:"a", ...}])` → `{ bit: "a", count: 1, onlyTaskId: "a" }`
- `summarizeOwnedTasks([a, b])` → `{ bit: "⊕2", count: 2 }`
- `roiBucket(100, 1)` → `"high"`; `roiBucket(60, 1)` → `"mid"`; `roiBucket(20, 1)` → `"low"`; `roiBucket(50, 0)` → `"infinite"`
- `agentStatusHistogram([])` → empty map; with mixed agents returns a per-status count map.
- `classifyEventVerb("task add foo")` → `{verb:"task add", rest:" foo"}`; `classifyEventVerb("nothing")` → `null`; `classifyEventVerb("task addnote x")` → `null` (boundary).

**Verify:**
```bash
npm run test -- state-helpers
```

**Commit:** `test: cover SDK seam helpers (summarize/roi/histogram/classify)`

---

## Wave 3: Static `mu state` shrink + dispatch branch

Goal: delete the HUD code per `audit_state_ts`, add the TUI dispatch branch in `cmdState` per `design_module_layout`.

### Task 13: Delete HUD-specific helpers from `src/cli/state.ts`
**File:** `src/cli/state.ts`
**Time:** ~10 min

**Steps:**
1. Delete `hudPaneSize`, `MU_HUD_FORCE_SIZE` env handling, `newHudTable`, `Tagged`/`tag`/`wsCell`, `formatHudAgentsTable`, `formatHudTasksTable`, `formatHudRecentTable`, `formatHudTracksTable`, `colorEventPayload` (the colour-render half — `classifyEventVerb` already replaced the parsing half), and `renderHudMode`.
2. Remove `--hud` and `-n/--lines` from `wireStateCommands` option declarations.
3. Remove `StateOpts.hud` and `StateOpts.lines` fields.
4. Remove the hud branch in `cmdState`.
5. Update the regression test `test/state-render.test.ts:395-444` for `colorEventPayload` to test `classifyEventVerb` instead (assert non-null for every prefix).

**Verify:**
```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

**Commit:** `state: remove --hud render mode (replaced by interactive TUI)`

---

### Task 14: Replace `loadWorkstreamData` with `loadWorkstreamSnapshot` calls
**File:** `src/cli/state.ts`
**Time:** ~5 min

**Steps:**
1. Remove `PerWsData` + `loadWorkstreamData` (now in `src/state.ts`).
2. Replace internal calls with `loadWorkstreamSnapshot(db, ws, { eventLimit: 200 })`.

**Verify:**
```bash
npm run typecheck && npm run test
```

**Commit:** `state: route renderers through loadWorkstreamSnapshot`

---

### Task 15: Add the TUI dispatch branch in `cmdState`
**File:** `src/cli/state.ts`
**Time:** ~5 min

**Steps:** add the branch from `design_module_layout`:
```ts
export async function cmdState(db: Db, opts: StateOpts): Promise<void> {
  if (opts.json) return renderStateJson(db, opts);
  if (process.stdout.isTTY && process.stdin.isTTY && !opts.mission) {
    const { runTui } = await import("./tui/index.js");
    return runTui(db, opts);
  }
  return renderStateStatic(db, opts);
}
```
(Adjust `renderStateStatic`/`renderStateJson` names to whatever your post-shrink renderers are called.)

**Verify:**
```bash
# In a TTY this errors with "runTui: not implemented yet" (expected).
# In a non-TTY (the default in tests/CI) the static path runs.
npm run typecheck && npm run test
echo '{}' | node dist/cli.js state -w tui --json
```

**Commit:** `state: dispatch to TUI on TTY; static otherwise`

---

### Task 16: Add a unit test for the dispatch branch
**File:** `test/state-dispatch.test.ts` (new)
**Time:** ~5 min

**Steps:** mock `process.stdout.isTTY` and `process.stdin.isTTY`; assert:
- `--json` always hits the JSON renderer regardless of TTY.
- `--mission` always hits the static renderer regardless of TTY.
- TTY + no flags hits the TUI dynamic-import (mock the `import()`).
- non-TTY + no flags hits the static renderer.

**Verify:**
```bash
npm run test -- state-dispatch
```

**Commit:** `test: cover cmdState TTY/JSON/mission dispatch matrix`

---

## Wave 4: TUI core (yank, keys, state, app)

Goal: implement the framework. Cards/popups still placeholders.

### Task 17: Implement `src/cli/tui/yank.ts` clipboard probe
**File:** `src/cli/tui/yank.ts`
**Time:** ~15 min

**Steps:** per `design_yank_flow` + `investigate_clipboard`:
```ts
import { execa } from "execa";

export type ClipboardBackend =
  | { kind: "cli"; cmd: string; args: string[] }
  | { kind: "osc52" }
  | null;

export async function probeClipboardBackend(): Promise<ClipboardBackend> {
  // platform-specific priority order; cache result by caller (one probe per session)
  // darwin → pbcopy; linux+wayland → wl-copy; linux+x11 → xclip|xsel; wsl → clip.exe
  // fallback → osc52; final fallback → null
  // Use `which` via execa to detect each binary; first hit wins.
  // ...
}

export interface YankResult { copied: boolean; backend: string | null; error?: string; }

export async function yank(text: string, backend: ClipboardBackend): Promise<YankResult> {
  if (!backend) return { copied: false, backend: null };
  if (backend.kind === "cli") {
    try {
      await execa(backend.cmd, backend.args, { input: text });
      return { copied: true, backend: backend.cmd };
    } catch (err) {
      return { copied: false, backend: backend.cmd, error: String(err) };
    }
  }
  // osc52
  try {
    const { writeFile } = await import("node:fs/promises");
    const seq = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
    await writeFile("/dev/tty", seq);
    return { copied: true, backend: "osc52" };
  } catch (err) {
    return { copied: false, backend: "osc52", error: String(err) };
  }
}
```

**Verify:**
```bash
npm run typecheck
```

**Commit:** `tui: implement clipboard probe + yank (CLI backends + OSC-52 fallback)`

---

### Task 18: Add unit test for `yank.ts`
**File:** `test/tui-yank.test.ts` (new)
**Time:** ~10 min

**Steps:** TDD — mock `execa`; assert:
- Probe returns the right backend per platform/env vars.
- `yank` with `null` backend returns `{copied:false, backend:null}`.
- `yank` with CLI backend invokes execa with correct args.
- `yank` returns `{copied:false, error: "..."}` on execa failure.

**Verify:**
```bash
npm run test -- tui-yank
```

**Commit:** `test: cover yank.ts probe + write paths`

---

### Task 19: Implement `src/cli/tui/keys.ts` dispatcher (global)
**File:** `src/cli/tui/keys.ts`
**Time:** ~15 min

**Steps:** per `design_global_keymap`:
```ts
export type GlobalAction =
  | { kind: "toggleCard"; cardId: 1 | 2 | 3 | 4 }
  | { kind: "openPopup"; cardId: 1 | 2 | 3 | 4 }
  | { kind: "tickFaster" }
  | { kind: "tickSlower" }
  | { kind: "tickReset" }
  | { kind: "refreshNow" }
  | { kind: "toggleHelp" }
  | { kind: "quit" }
  | { kind: "clearFooter" }
  | { kind: "workstreamPicker" }
  | { kind: "noop" };

export function dispatchGlobalKey(input: string, key: { ctrl?: boolean; shift?: boolean; meta?: boolean; escape?: boolean; return?: boolean; }): GlobalAction {
  if (key.ctrl && input === "c") return { kind: "quit" };
  if (input === "q" || input === "Q") return { kind: "quit" };
  if (input === "?") return { kind: "toggleHelp" };
  if (input === "r") return { kind: "refreshNow" };
  if (input === "c") return { kind: "clearFooter" };
  if (input === "w") return { kind: "workstreamPicker" };
  if (input === "+" || input === "=") return { kind: "tickFaster" };
  if (input === "-") return { kind: "tickSlower" };
  if (input === "0") return { kind: "tickReset" };
  // 1-4 toggle cards
  if (input >= "1" && input <= "4") {
    const cardId = (input.charCodeAt(0) - "0".charCodeAt(0)) as 1 | 2 | 3 | 4;
    return { kind: "toggleCard", cardId };
  }
  // !-$ open popups (Shift+1..Shift+4 on US)
  const glyphMap: Record<string, 1 | 2 | 3 | 4> = { "!": 1, "@": 2, "#": 3, "$": 4 };
  const popupId = glyphMap[input];
  if (popupId !== undefined) return { kind: "openPopup", cardId: popupId };
  return { kind: "noop" };
}
```

**Verify:**
```bash
npm run typecheck
```

**Commit:** `tui: implement global keymap dispatcher (1-4 toggle, !-$ open popup, +/-/0 tick, q/?/r/c/w)`

---

### Task 20: Add unit test for global keymap
**File:** `test/tui-keys.test.ts` (new)
**Time:** ~10 min

**Steps:** assert each binding from `design_global_keymap` summary table maps to the right `GlobalAction`. Cover the Shift-glyph-row mapping.

**Verify:**
```bash
npm run test -- tui-keys
```

**Commit:** `test: cover global keymap dispatcher (every binding)`

---

### Task 21: Implement `src/cli/tui/state.ts` (tick + refs)
**File:** `src/cli/tui/state.ts`
**Time:** ~20 min

**Steps:** per `design_poll_loop` — pure TS module with React hooks:
```ts
import { useEffect, useRef, useState } from "react";
import type { Db } from "../../db.js";
import {
  type WorkstreamSnapshot,
  loadWorkstreamSnapshot,
} from "../../state.js";

export const TICK_DEFAULT_MS = 1000;
export const TICK_FLOOR_MS = 100;
export const TICK_CEILING_MS = 10_000;

export interface CardVisibility { agents: boolean; tracks: boolean; ready: boolean; log: boolean; }
export const DEFAULT_CARD_VISIBILITY: CardVisibility = { agents: true, tracks: true, ready: true, log: true };

export interface DashboardSnapshot {
  data: WorkstreamSnapshot | null;
  lastTickMs: number;
  error: string | null;
}

export function useDashboardSnapshot(
  db: Db,
  workstream: string,
  tickMs: number,
  enabled: boolean,        // pause when popup is open
): DashboardSnapshot {
  const [snap, setSnap] = useState<DashboardSnapshot>({ data: null, lastTickMs: 0, error: null });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const t0 = performance.now();
      try {
        const data = loadWorkstreamSnapshot(db, workstream, { eventLimit: 200 });
        const dur = performance.now() - t0;
        setSnap({ data, lastTickMs: dur, error: null });
      } catch (err) {
        setSnap((s) => ({ ...s, error: String(err) }));
      }
    };
    tick();
    const id = setInterval(tick, tickMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [db, workstream, tickMs, enabled]);
  return snap;
}

export function clampTick(ms: number): number {
  return Math.max(TICK_FLOOR_MS, Math.min(TICK_CEILING_MS, ms));
}
```

**Verify:**
```bash
npm run typecheck
```

**Commit:** `tui: implement poll-loop hook (1s default, +/- adjust, popup pauses)`

---

### Task 22: Implement `src/cli/tui/index.ts` (entrypoint)
**File:** `src/cli/tui/index.ts`
**Time:** ~10 min

**Steps:** replace placeholder with the real bootstrap:
```ts
import { createElement } from "react";
import { render } from "ink";
import type { Db } from "../../db.js";
import type { StateOpts } from "../state.js";
import { App } from "./app.js";

export async function runTui(db: Db, opts: StateOpts): Promise<void> {
  const { workstream } = opts;
  if (!workstream) throw new Error("runTui: workstream is required");
  const { waitUntilExit } = render(
    createElement(App, { db, workstream }),
    { exitOnCtrlC: true },
  );
  await waitUntilExit();
}
```

**Verify:**
```bash
npm run typecheck && npm run build
```

**Commit:** `tui: real runTui entrypoint (bootstrap ink renderer)`

---

### Task 23: Implement `<App>` root with popup state machine
**File:** `src/cli/tui/app.tsx`
**Time:** ~30 min

**Steps:** per `design_card_iface` + `design_popup_lifecycle`:
- `useInput` calls `dispatchGlobalKey`; updates `cardVisibility`, `tickMs`, `popup`, `footer`, `helpOpen`.
- Renders `<Help>` overlay when `helpOpen`; renders the active popup when `popup !== null`; otherwise renders `<Dashboard>`.
- Uses `useDashboardSnapshot(db, workstream, tickMs, popup === null)`.
- Tracks footer line as `{ command: string, copied: boolean } | null`.
- Defines a single popup → component map: `{ 1: AgentsPopup, 2: TracksPopup, 3: ReadyPopup, 4: LogPopup }`.

Read `design_popup_lifecycle` notes for the exact `PreservedDashboardState` shape and the on-open hook contract before writing.

**Verify:**
```bash
npm run typecheck && npm run build
# A manual smoke test in a TTY: `node dist/cli.js state -w tui` should render
# and respond to 1-4 (toggle), Shift+1-4 (popup), q (quit), ? (help).
```

**Commit:** `tui: <App> root with popup state machine + global keymap wiring`

---

### Task 24: Add unit test for popup-lifecycle state restore
**File:** `test/tui-app.test.ts` (new)
**Time:** ~15 min

**Steps:** use `ink-testing-library`:
```bash
npm install --save-dev ink-testing-library
```
Render `<App>`; toggle card 1 off; open popup 2 (Shift+2 → `@`); close popup (Esc); assert card 1 is still off and tick rate preserved.

**Verify:**
```bash
npm run test -- tui-app
```

**Commit:** `test: cover popup-lifecycle state restore`

---

## Wave 5: Cards (4 in parallel)

Each card gets its own task because they're independent post-`design_card_iface`.

### Task 25: Implement `cards/agents.tsx`
**File:** `src/cli/tui/cards/agents.tsx`
**Time:** ~15 min

**Steps:** per `design_card_agents`:
- Props: `{ snapshot: WorkstreamSnapshot, focused: boolean }`
- Header: `Agents (3 ✓ alive · 1 ⚠ idle)` using `agentStatusHistogram`
- Rows: `name | status emoji | summarizeOwnedTasks(...).bit | idle | ws-behind`
- Reuse `src/detect.ts` `AgentStatus` glyphs verbatim (don't fork iconography).
- Empty state: `"No agents yet — `mu agent spawn worker-1 -w …`"`.

Read full spec at `mu task notes design_card_agents -w tui`.

**Aesthetic:** wrap in `<Box borderStyle="round" borderColor="gray">`; section header inset into the top border per the Aesthetic block at the top of this plan.

**Verify:**
```bash
npm run typecheck && npm run build
```

**Commit:** `tui: implement Agents card`

---

### Task 26: Implement `cards/tracks.tsx`
**File:** `src/cli/tui/cards/tracks.tsx`
**Time:** ~15 min

**Steps:** per `design_card_tracks`. Use `snapshot.tracks` directly. ROI sum from `roiBucket` colours.

**Aesthetic:** rounded box, section header inset (e.g. `Tracks (2 · 1 ready)`).

**Verify:**
```bash
npm run typecheck && npm run build
```

**Commit:** `tui: implement Tracks card`

---

### Task 27: Implement `cards/ready.tsx`
**File:** `src/cli/tui/cards/ready.tsx`
**Time:** ~12 min

**Steps:** per `design_card_ready`. Top-N (default 10) sorted by ROI desc; tie-break effort asc, then name asc. Use `roiBucket` for colour buckets.

**Aesthetic:** rounded box, section header inset (e.g. `Ready (5)`).

**Verify:**
```bash
npm run typecheck && npm run build
```

**Commit:** `tui: implement Ready card`

---

### Task 28: Implement `cards/log.tsx`
**File:** `src/cli/tui/cards/log.tsx`
**Time:** ~15 min

**Steps:** per `design_card_log`. Card has fixed-height summary (no scroll; that's the popup). Use `classifyEventVerb` for verb colouring. Auto-update on tick (no scroll-pause needed at card level).

**Aesthetic:** rounded box, section header inset (e.g. `Activity log (last ↑10)`).

**Verify:**
```bash
npm run typecheck && npm run build
```

**Commit:** `tui: implement Activity-log card`

---

### Task 29: Wire cards into `<Dashboard>` (in `app.tsx`)
**File:** `src/cli/tui/app.tsx`
**Time:** ~10 min

**Steps:** add `<Dashboard>` component that renders the four cards in a flex layout with their visibility flags, plus a footer line (1 row, persistent yank display).

**Verify:**
```bash
npm run build
# Manual smoke: `node dist/cli.js state -w tui` shows 4 cards live-updating.
```

**Commit:** `tui: render the 4 cards in the Dashboard layout`

---

### Task 30: Add unit tests per card (one each)
**Files:** `test/tui-card-{agents,tracks,ready,log}.test.ts`
**Time:** ~5 min × 4 = 20 min

**Steps:** for each card, render with a fixture `WorkstreamSnapshot` and assert the lastFrame() contains the expected text (agent names, track headers, task ids, event verbs). Use ink-testing-library.

**Verify:**
```bash
npm run test -- tui-card
```

**Commit:** `test: cover each card's render output (agents/tracks/ready/log)`

---

## Wave 6: Popups (4 in parallel)

### Task 31: Implement `popups/agents.tsx`
**File:** `src/cli/tui/popups/agents.tsx`
**Time:** ~25 min

**Steps:** per `design_popup_agents`. Two-pane (25/75): agent list left, scrollback right. **Aesthetic:** outer rounded box `╭─ Agents · popup ──╮`; inner sub-boxes for each pane with their own headers (`╭─ list ─╮`, `╭─ scrollback · worker-1 ─╮`). On-open hook fetches pane scrollback (`mu agent read`). Per-popup verbs: `f`, `o`, `e` plus `y` yank matrix. In-popup convention keys (j/k g/G / Esc y ?) handled by a shared helper if you can extract one cleanly; otherwise per-popup.

**Verify:**
```bash
npm run build
```

**Commit:** `tui: implement Agents popup with scrollback drill`

---

### Task 32: Implement `popups/tracks.tsx`
**File:** `src/cli/tui/popups/tracks.tsx`
**Time:** ~20 min

**Steps:** per `design_popup_tracks`. Per-track expandable list; `e` to expand/collapse; `t` to jump to task tree. **Aesthetic:** outer rounded box `╭─ Tracks · popup ─╮`.

**Verify:**
```bash
npm run build
```

**Commit:** `tui: implement Tracks popup with per-track drill`

---

### Task 33: Implement `popups/ready.tsx` (the Tasks popup)
**File:** `src/cli/tui/popups/ready.tsx`
**Time:** ~30 min

**Steps:** per `design_popup_tasks`. Two-pane; selected task detail with notes preview; full yank matrix:
- OPEN+ready: `mu task claim <id> -w <ws>`
- OPEN+owned: `mu task release <id> -w <ws>`
- IN_PROGRESS+self: `mu task close <id> -w <ws> --evidence "..."`
- CLOSED: `mu task open <id> -w <ws>`
- (etc.)

This is the most complex popup. Consult `design_popup_tasks` notes verbatim. **Aesthetic:** outer rounded box `╭─ Tasks · popup ─╮`; inner sub-boxes for list-pane / detail-pane.

**Verify:**
```bash
npm run build
```

**Commit:** `tui: implement Tasks popup (full yank matrix)`

---

### Task 34: Implement `popups/log.tsx`
**File:** `src/cli/tui/popups/log.tsx`
**Time:** ~25 min

**Steps:** per `design_popup_log`. Auto-tail with scroll-pause (toast "tail paused; G to resume" when scrolled up). Filters: `/` substring, `e` event-kind cycle, `m` my-events. **Aesthetic:** outer rounded box `╭─ Activity log · popup ─╮`; tail-paused indicator in the header (e.g. `⏸ paused`).

**Verify:**
```bash
npm run build
```

**Commit:** `tui: implement Activity-log popup (auto-tail with scroll-pause)`

---

### Task 35: Add unit tests per popup
**Files:** `test/tui-popup-{agents,tracks,ready,log}.test.ts`
**Time:** ~10 min × 4 = 40 min

**Steps:** for each popup, render with a fixture, send keys, assert behavior:
- `j`/`k` advance/retreat selection
- `y` produces the right yank command for the focused row (cite `design_popup_tasks` matrix for the most important assertions)
- `Esc` closes (verify by checking `onClose` callback fired)
- `/` enters filter mode

**Verify:**
```bash
npm run test -- tui-popup
```

**Commit:** `test: cover each popup's nav + yank + filter behavior`

---

## Wave 7: Help overlay + resize + ergonomics

### Task 36: Implement `help.tsx`
**File:** `src/cli/tui/help.tsx`
**Time:** ~15 min

**Steps:** per `design_help_overlay`. Modal-ish overlay; renders the keymap summary table from `design_global_keymap`. When opened from inside a popup, includes that popup's per-popup verbs. `?` / `Esc` / `q` close. **Aesthetic:** rounded box `╭─ keys ─╮`; same family as cards/popups.

**Verify:**
```bash
npm run build
# Manual smoke: launch TUI, press `?`, see help overlay.
```

**Commit:** `tui: implement help overlay (?/F1)`

---

### Task 37: Add resize handling in `<App>`
**File:** `src/cli/tui/app.tsx`
**Time:** ~10 min

**Steps:** per `design_resize`. Use ink's `useStdout()` for `stdout.columns`/`stdout.rows`. Cards declare `minWidth`/`minHeight`; below min, hide with footer toast. Debounce resize events (~100ms).

**Verify:**
```bash
npm run build
```

**Commit:** `tui: resize handling with per-card minWidth + reflow`

---

### Task 38: Add yank toast to popups + footer line to dashboard
**File:** `src/cli/tui/app.tsx`, `src/cli/tui/popups/*.tsx`
**Time:** ~15 min

**Steps:** per `design_yank_flow` A3':
- Footer line on dashboard: persistent until next yank or `c`.
- Toast inside popup: 2s timer + clears on next keypress.
- Format: `last: <command>  [copied|no clipboard]`.

**Verify:**
```bash
npm run build
# Manual smoke: yank in a popup, see toast; close popup, see footer.
```

**Commit:** `tui: yank toast + dashboard footer (A3' flow)`

---

## Wave 8: Acceptance test + manual QA

### Task 39: End-to-end acceptance test
**File:** `test/tui-acceptance.test.ts` (new)
**Time:** ~20 min

**Steps:** per `design_tests` §4. Spin up an in-memory mu DB with fixture (1 workstream, 2 agents, 4 tasks); render `<App>`; send keys: `1` (toggles agents off), `#` (Shift+3 = open Ready popup), `j`, `j`, `y`; assert the yanked command equals `mu task claim <expected_id> -w <ws>`.

**Verify:**
```bash
npm run test -- tui-acceptance
```

**Commit:** `test: end-to-end acceptance test (toggle → popup → nav → yank)`

---

### Task 40: Verify acceptance + four-greens
**Time:** ~5 min

**Steps:** the gate every PR must pass.
```bash
npm run typecheck && npm run lint && npm run test && npm run build
```
If any fail, fix before proceeding.

**Commit:** none (verification only)

---

### Task 41: Manual smoke (real TTY)
**Time:** ~10 min

**Steps:** in a fresh terminal:
```bash
MU_DB_PATH=/tmp/mu-smoke.db node dist/cli.js workstream init smoke
MU_DB_PATH=/tmp/mu-smoke.db node dist/cli.js task add -w smoke --title "Demo" --impact 50 --effort-days 1
MU_DB_PATH=/tmp/mu-smoke.db node dist/cli.js state -w smoke   # → TUI
```
Manual checklist:
- [ ] All 4 cards visible.
- [ ] `1`–`4` toggles each card.
- [ ] `Shift+1`–`Shift+4` opens each popup; `Esc` closes; dashboard state preserved.
- [ ] `+` / `-` adjusts tick rate; `0` resets.
- [ ] `?` shows help; `Esc` closes.
- [ ] `y` inside Ready popup yanks `mu task claim demo -w smoke`; footer shows it.
- [ ] `q` quits cleanly.
- [ ] `node dist/cli.js state -w smoke --json` still produces JSON.
- [ ] `node dist/cli.js state -w smoke | cat` (non-TTY) shows static card.

**Commit:** none (verification only)

---

## Wave 9: Docs

Apply the drafted amendments. Each is a single-file edit consuming a task note.

### Task 42: Apply `VISION.md` amendment
**File:** `docs/VISION.md`
**Time:** ~5 min

**Steps:** copy the AFTER block from `mu task notes docs_vision_amend -w tui` and apply (replace Constraint #6 with the expanded #6+#7 pair).

**Verify:**
```bash
git diff docs/VISION.md
```

**Commit:** `vision: name short-lived-process pillar; carve TUI exception`

---

### Task 43: Apply `ROADMAP.md` amendment
**File:** `docs/ROADMAP.md`
**Time:** ~5 min

**Steps:** copy AFTER block from `mu task notes docs_roadmap_amend -w tui`. Replace L72 with the two new bullets (ink-in-TUI-only + no-second-render-stack).

**Verify:**
```bash
git diff docs/ROADMAP.md
```

**Commit:** `roadmap: permit ink in TUI subtree; refuse second render stack`

---

### Task 44: Apply `VOCABULARY.md` additions
**File:** `docs/VOCABULARY.md`
**Time:** ~10 min

**Steps:** insert each new term from `mu task notes docs_vocab_amend -w tui` in alphabetical position.

**Verify:**
```bash
git diff docs/VOCABULARY.md
grep -E '^\*\*(card|popup|tick|yank|footer|toast|TUI|dashboard|act-intent|help overlay|glanceable|drill-down)' docs/VOCABULARY.md
```

**Commit:** `vocab: add TUI/card/popup/tick/yank/footer/toast/etc. entries`

---

### Task 45: Apply `CHANGELOG.md` entry
**File:** `CHANGELOG.md`
**Time:** ~5 min

**Steps:** copy entry from `mu task notes docs_changelog -w tui` under the upcoming version.

**Verify:**
```bash
git diff CHANGELOG.md
```

**Commit:** `changelog: TUI release notes (added/changed/removed/pillar amendments)`

---

### Task 46: Apply `USAGE_GUIDE.md` updates
**File:** `docs/USAGE_GUIDE.md`
**Time:** ~10 min

**Steps:** consume `mu task notes docs_usage_guide -w tui`:
1. Add new TUI section.
2. Remove every existing `--hud` reference (the note lists exact line ranges).

**Verify:**
```bash
grep -n "hud\|--hud" docs/USAGE_GUIDE.md   # should print nothing
```

**Commit:** `docs: USAGE_GUIDE TUI section + remove --hud references`

---

### Task 47: Add ARCHITECTURE.md row for `src/cli/tui/`
**File:** `docs/ARCHITECTURE.md`
**Time:** ~5 min

**Steps:** add a row to the Modules table per `design_module_layout`. Follow the format of existing rows.

**Verify:**
```bash
git diff docs/ARCHITECTURE.md
```

**Commit:** `architecture: document src/cli/tui/ cluster (TUI subtree)`

---

### Task 48: Update `AGENTS.md` repo layout (optional)
**File:** `AGENTS.md`
**Time:** ~3 min

**Steps:** if the layout block lists `src/cli/` subdirs explicitly, add `src/cli/tui/` with its theme.

**Verify:** `grep src/cli/tui AGENTS.md`

**Commit:** `agents.md: list src/cli/tui/ in repo layout` (if changed)

---

### Task 49: Update `skills/mu/SKILL.md` if it mentions `--hud`
**File:** `skills/mu/SKILL.md`
**Time:** ~3 min

**Steps:**
```bash
grep -n "hud\|--hud" skills/mu/SKILL.md
```
If matches: update to reflect the TUI replacement (one-line note in the right section).

**Commit:** `skill: drop --hud references; mention interactive TUI` (if changed)

---

## Wave 10: Final verification

### Task 50: Final four-greens
**Time:** ~5 min

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

If anything fails, fix it. Acceptance test (`test/acceptance.test.ts`) MUST pass.

**Commit:** none

---

### Task 51: Walkthrough manual smoke once more, in a clean terminal
**Time:** ~10 min

Same checklist as Task 41 but on a fresh terminal session, fresh `/tmp/mu-smoke.db`. The acceptance gate is "does this feel like lazygit / btop?"

**Commit:** none

---

## Progress Tracker

### Wave 1: Foundations
- [ ] Task 1: Add ink + react dependencies
- [ ] Task 2: Enable JSX in tsconfig
- [ ] Task 3: Create `src/cli/tui/` scaffold (empty files)
- [ ] Task 4: Update `biome.json` to handle JSX (if needed)

### Wave 2: SDK seam (`src/state.ts`)
- [ ] Task 5: Add `WorkstreamSnapshot` type + `loadWorkstreamSnapshot`
- [ ] Task 6: Move `resolveWorkstreamSet` to `src/state.ts`
- [ ] Task 7: Add `agentStatusHistogram` to `src/state.ts`
- [ ] Task 8: Add `summarizeOwnedTasks` to `src/state.ts`
- [ ] Task 9: Add `roiBucket` to `src/state.ts`
- [ ] Task 10: Add `classifyEventVerb` to `src/logs.ts`
- [ ] Task 11: Re-export new helpers from `src/index.ts`
- [ ] Task 12: Add unit tests for new SDK helpers

### Wave 3: Static `mu state` shrink + dispatch branch
- [ ] Task 13: Delete HUD-specific helpers from `src/cli/state.ts`
- [ ] Task 14: Replace `loadWorkstreamData` with `loadWorkstreamSnapshot` calls
- [ ] Task 15: Add the TUI dispatch branch in `cmdState`
- [ ] Task 16: Add a unit test for the dispatch branch

### Wave 4: TUI core (yank, keys, state, app)
- [ ] Task 17: Implement `src/cli/tui/yank.ts` clipboard probe
- [ ] Task 18: Add unit test for `yank.ts`
- [ ] Task 19: Implement `src/cli/tui/keys.ts` dispatcher
- [ ] Task 20: Add unit test for global keymap
- [ ] Task 21: Implement `src/cli/tui/state.ts` (tick + refs)
- [ ] Task 22: Implement `src/cli/tui/index.ts` (entrypoint)
- [ ] Task 23: Implement `<App>` root with popup state machine
- [ ] Task 24: Add unit test for popup-lifecycle state restore

### Wave 5: Cards (4 in parallel)
- [ ] Task 25: Implement `cards/agents.tsx`
- [ ] Task 26: Implement `cards/tracks.tsx`
- [ ] Task 27: Implement `cards/ready.tsx`
- [ ] Task 28: Implement `cards/log.tsx`
- [ ] Task 29: Wire cards into `<Dashboard>` (in `app.tsx`)
- [ ] Task 30: Add unit tests per card (one each)

### Wave 6: Popups (4 in parallel)
- [ ] Task 31: Implement `popups/agents.tsx`
- [ ] Task 32: Implement `popups/tracks.tsx`
- [ ] Task 33: Implement `popups/ready.tsx` (the Tasks popup)
- [ ] Task 34: Implement `popups/log.tsx`
- [ ] Task 35: Add unit tests per popup

### Wave 7: Help overlay + resize + ergonomics
- [ ] Task 36: Implement `help.tsx`
- [ ] Task 37: Add resize handling in `<App>`
- [ ] Task 38: Add yank toast to popups + footer line to dashboard

### Wave 8: Acceptance test + manual QA
- [ ] Task 39: End-to-end acceptance test
- [ ] Task 40: Verify acceptance + four-greens
- [ ] Task 41: Manual smoke (real TTY)

### Wave 9: Docs
- [ ] Task 42: Apply `VISION.md` amendment
- [ ] Task 43: Apply `ROADMAP.md` amendment
- [ ] Task 44: Apply `VOCABULARY.md` additions
- [ ] Task 45: Apply `CHANGELOG.md` entry
- [ ] Task 46: Apply `USAGE_GUIDE.md` updates
- [ ] Task 47: Add ARCHITECTURE.md row for `src/cli/tui/`
- [ ] Task 48: Update `AGENTS.md` repo layout (optional)
- [ ] Task 49: Update `skills/mu/SKILL.md` if it mentions `--hud`

### Wave 10: Final verification
- [ ] Task 50: Final four-greens
- [ ] Task 51: Walkthrough manual smoke once more

---

## Notes

### Where the design lives

Every design decision behind this plan is captured as a durable note on a closed task in workstream `tui`. Read any of them with:

```bash
mu task notes <task-id> -w tui
```

Key notes (in order of usefulness when stuck):

| Implementing… | Read note on… |
|---|---|
| anything | `design_locked` (the brainstorm output, all locked decisions) |
| Wave 1 (deps/scaffold) | `design_module_layout` (file tree + tsconfig delta + budgets) |
| Wave 2 (SDK seam) | `design_sdk_seam` (exact signatures + caller list) |
| Wave 3 (state shrink) | `audit_state_ts` (KEEP/PORT/DELETE buckets, line-precise) |
| Wave 4 yank | `design_yank_flow` + `investigate_clipboard` (backend matrix) |
| Wave 4 keys | `design_global_keymap` (every binding, glyph-row caveat) |
| Wave 4 tick | `design_poll_loop` (synchronous SQLite, no race contract) |
| Wave 4 popup state | `design_popup_lifecycle` (state machine + restore contract) |
| Wave 5 cards | `design_card_{agents,tracks,ready,log}` |
| Wave 6 popups | `design_popup_{agents,tracks,ready,log}` (incl. yank matrices) |
| Wave 7 help | `design_help_overlay` |
| Wave 7 resize | `design_resize` |
| Wave 8 tests | `design_tests` (ink-testing-library strategy + e2e) |
| Wave 9 docs | `docs_{vision,roadmap,vocab,changelog,usage_guide}_amend` (literal diff text) |

### Pillar tensions to watch

This feature amends two anti-feature pledges and one VISION pillar. **Do not let scope creep undo this.** Specifically:

- ink lives ONLY in `src/cli/tui/`. Adding `import 'ink'` anywhere else in `src/` is a regression — Wave 9's ROADMAP amendment commits to this.
- The TUI is read-only against SQLite. NEVER make a TUI keypress execute a `mu` verb directly. Always yank the command and let the user run it. R1 from `design_locked` is load-bearing.
- No persistence of card visibility / tick rate. Don't add a `tui_prefs` table or a `~/.murc`. The brainstorm rejected this; defaults must stay good enough.

### Order matters within waves

Waves are sequential. Within a wave, tasks usually have parent/child relationships visible by file path:
- Wave 5: cards depend on Wave 4 (state hook + Dashboard wrapper). Cards parallelize.
- Wave 6: popups depend on Wave 5 (cards) ONLY because the popup's `Esc` returns to the dashboard which renders cards. Strictly speaking the popup can render against placeholder cards, but it's awkward.
- Wave 9 docs all parallelize.

### LOC budget

Per `design_module_layout`, the cluster is budgeted at ~1450 LOC across 14 files, largest single file ~150 LOC. **If any file is creeping above 200 LOC during implementation, stop and refactor** — extract a helper, split a card into card+row sub-component, or move shared logic into `src/cli/tui/state.ts` or `src/cli/tui/keys.ts`. The cluster's value over a single `src/cli/tui.ts` is exactly this — don't waste it.

### When to `commit` mid-task

The plan suggests one commit per task (Conventional Commits, `tui:` / `state:` / `test:` / `docs:` prefixes). When a task spans multiple files (e.g. Task 13 touches state.ts + tests), one commit at the end is fine. Always run typecheck + lint + test + build before committing — that's the project rule, not a suggestion.

### Resuming this plan

The Progress Tracker above is the resumption point. Mark each `[ ]` as `[x]` after the commit lands. If interrupted mid-wave, the current state is `git status` + `git log --oneline -5`. The design notes never go stale — they're the durable memory the next agent inherits.

---

Plan ready. Invoke the `execute-plan` skill (or just say "start executing" / "go") to begin Wave 1, Task 1.
