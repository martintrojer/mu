# Test conventions for TUI behaviour

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
