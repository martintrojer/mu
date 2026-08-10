# Test conventions

Two topics live here: [mux tests](#mux-tests) (which tier, which seam)
and [TUI behaviour tests](#tui-behaviour-tests) (CaptureStream over
source-greps).

## Mux tests

mu drives two multiplexers (`tmux`, `herdr`) behind the `MuxBackend`
interface. Which tier your test belongs to is decided by one question:
**does it need a real multiplexer?**

### Fast tier — `*.test.ts`, use `installMux()`

Almost every mux test belongs here. `test/_mux.ts` is the seam: one call
installs the backend *and* stubs that backend's executor, and returns a
single `restore()`.

```ts
import { installMux, type MuxHarness } from "./_mux.js";
import { WORKSPACE_LIST } from "./_mux-fixtures.js";

let harness: MuxHarness | undefined;
afterEach(() => {
  harness?.restore();
  harness = undefined;
});

it("lists sessions", async () => {
  harness = installMux("herdr", [["workspace list", WORKSPACE_LIST]]);
  expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  expect(harness.argsOf(0)).toEqual(["workspace", "list"]);
});
```

- Routes are **prefix-matched** against the space-joined args vector;
  first match wins, so order narrow routes before broad ones. An
  unrouted call returns exit 1 with `unrouted: <cmd>` in stderr — a real
  substrate failure, naming the route you forgot.
- Pass a **function** instead of a routing table for stateful stubs or
  to assert a code path never shells out (`throw` inside it).
- Canned responses live in `test/_mux-fixtures.ts` — verbatim captures
  from a real herdr server. Import them; never re-inline a payload in a
  test file, or the recordings drift apart file by file.
- `installUnreachableMux(backend, errFactory)` models a box with **no**
  multiplexer: every method rejects. Use it to prove load-bearing call
  sites propagate `NoMultiplexerError` and best-effort ones degrade.

Fast-tier rules from AGENTS.md apply unchanged: no real subprocess, no
sleeps >50ms, per-test temp DBs only.

### Integration tier — `*.integration.test.ts`, must self-skip

Only when the test genuinely needs the real substrate. Gate on the
helpers in `test/_mux.ts`:

| Backend | Gate | Isolation |
| --- | --- | --- |
| tmux | `tmuxIntegrationAvailable()` (i.e. `$TMUX` is set) | **Structural** — `MU_TMUX_SOCKET` points the suite at a private `-L <socket>` server (see `_global-teardown.ts`) |
| herdr | `await herdrIntegrationAvailable()` — server RUNNING *and* protocol COMPATIBLE, not merely installed | **Explicit** — `MU_HERDR_SESSION` names a private session; there is no private-socket equivalent |

### ⚠️ The herdr blast shield

tmux gets a private socket, so a buggy tmux test is contained. **herdr
has no such backstop.** Its only isolation is `--session <name>`, which
mu routes to via `MU_HERDR_SESSION`. A herdr test that reaches the
*default* session destroys the user's real panes, the agents in them,
and their unsaved work. There is no undo, and no sweep can distinguish a
user pane from test residue.

Therefore, non-negotiably:

- **Never** run `herdr server stop` / `restart` / `kill` from the suite,
  and never kill the main herdr process. These are shared-fate: mu
  cannot rely on them being session-scoped, so they are banned even
  inside a correctly isolated session.
- **Never** touch the `default` session.
- Clean up **per-entity** (close the workspaces your test created), not
  by nuking a server.
- Route real herdr commands through **`herdrTestExec()`**. It calls
  `assertHerdrIsolated()` on every invocation — refusing to run when
  `MU_HERDR_SESSION` is unset, empty, or `default` — and rejects the
  fatal verbs before spawning anything. Get a unique session name from
  `freshHerdrSession()`.

These guards are runtime assertions, not comments, and
`test/mux-test-seam.test.ts` exercises them. That is deliberate: a
safety rule nobody has executed is a wish.

There is intentionally **no herdr equivalent of the
`_global-teardown.ts` default-socket sweep.** That sweep's allowlist is
DB-rooted (`mu-<workstream>` names from the user's real DB), which works
only because tmux session names are mu's own namespace. herdr workspace
labels are not: the user labels workspaces by hand, mu-created and
human-created panes are indistinguishable, and a sweep that guessed
wrong would kill live user work. Prevention (the guards above) is the
only safe policy here; a cleanup sweep is not.

## TUI behaviour tests

Prefer CaptureStream-based behaviour tests over `readFileSync`
source-grep tests for popup/card behaviour.

## Pattern

```ts
const stdin = createInkInputStream();
const stdout = createInkCaptureStream({ columns: 120, rows: 30 });
const inst = render(createElement(MyPopup, props), {
  stdout,
  stdin,
  stderr: createInkCaptureStream({ columns: 120, rows: 30 }),
  debug: false,
  patchConsole: false,
});
await waitForInkOutput(stdout);
await simulateInput(stdin, "j");
await simulateInput(stdin, "enter");
const lines = latestRenderedFrame(stdout);
expect(lines.join("\n")).toContain("expected text");
inst.unmount();
```

See `test/_ink-render.ts` for the seam (`createInkInputStream`,
`createInkCaptureStream`, `simulateInput`, `latestRenderedFrame`).

## When source-greps ARE OK

Source-grep / `readFileSync` assertions belong ONLY in:

1. Keymap-spec ↔ help-pane consistency (cross-module spec consistency).
2. Anti-regression guards for previously-shipped fixes where the fix is a
   structural invariant (e.g. `overflow="hidden"` on the root `Box`,
   `wrap="truncate"` on drill body `Text`).
3. Wiring assertions across module boundaries (`App` imports `X`, `X` is a
   function).

## Why

Source-grep tests assert that implementation text exists, not that the TUI works.
They can pass while behaviour is broken because the searched literal still lives
in a comment, a dead branch, or a yank template that is no longer reachable. They
also fail on harmless refactors such as renaming a local variable, splitting JSX,
or moving a helper to another file.

CaptureStream tests exercise the user-facing contract instead: render the Ink
component, drive stdin the way a user would, and assert on the visible frame or
callbacks. That catches regressions in popup navigation, drill mode, filtering,
yank behaviour, clipping, and empty/loading states without pinning incidental
source shape.

Keep structural source-greps narrow and named as structural guards. If the test
can be phrased as “what should the user see?” or “what should this key do?”, use
the CaptureStream seam instead.
