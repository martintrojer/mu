---
id: "review_tests_yank_osc52_unverified"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: null
created_at: "2026-05-12T08:37:01.020Z"
updated_at: "2026-05-12T10:08:16.193Z"
blocked_by: []
blocks: []
---

# REVIEW low: OSC-52 fallback is never asserted in tui-yank tests

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:37:01.321Z

```
FILE + LINES:
  - test/tui-yank.test.ts:14-65
CATEGORY: weak-coverage
SEVERITY: low
FINDING: yank.ts has 4 backends:
   1. CLI (pbcopy / wl-copy / xclip / xsel / clip.exe) — covered by /bin/true + /bin/false tests.
   2. OSC-52 — NOT covered. yank() with `{kind:"osc52"}` writes to /dev/tty. The "writes to /dev/tty" code path is the actual fallback for SSH users without an X server; nothing exercises it. The test for `yank({kind:"cli", cmd:"true"})` covers the cli branch but NOT the osc52 branch.
   3. null backend — covered.
The probe (probeClipboardBackend) is platform-conditional and only asserts shape on the host — a regression in the WSL or Wayland branch is invisible.
SUGGESTED FIX:
   - Test yank with `{kind:"osc52"}`: redirect /dev/tty to a temp file (or assert that the ESC ] 52 ; c ; <base64> BEL sequence reaches a stub writer). Even a fixture that monkey-patches `writeFile` is fine; the goal is asserting we emit the right bytes.
   - Add platform-specific probe tests using a fake `process.platform` + WAYLAND_DISPLAY env: today only the host platform's branch executes.
NOTE: yank reliability matters because the entire TUI pivot is "model drives CLI; you copy commands from the popups". A silently broken OSC-52 branch means SSH users get [no clipboard] surprises in production.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T10:08:16.193Z

```
CLOSE: 665bd65e88a899b9b3be3f5459a53d9fe99761be: added osc52Writer + ProbeEnv injection seams to yank.ts; new osc52Sequence() helper; test/tui-yank.test.ts grows 5→21 tests covering OSC-52 byte framing, writer-throws path, exactly-one-invocation, plus 9 platform-conditional probe cases (darwin±pbcopy, WSL, linux+Wayland, linux+X11+xclip/xsel, prefers, fallback); 4 greens
```
