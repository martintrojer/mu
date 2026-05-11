// Shared fixture-name helpers for tests.
//
// Why this exists: every test that touches the SAME entity-namespace
// risks colliding with another concurrent test run. The big-ticket
// hazard is the tmux session namespace, which is shared across every
// process talking to the same tmux server: two `npm test` runs (e.g.
// orchestrator + worker agent in mu-tui-impl) racing on the same
// fixture name `mu-alpha` produces spurious `duplicate session` /
// `can't find session` errors mid-suite.
//
// The fix is a per-test-execution unique name. The shape is bounded
// (workstream names cap at 32 chars in the schema) so we encode
// pid + monotonic timestamp + 6 base36-random chars under a short
// caller-chosen prefix. base36 keeps 4-byte randomness in 6 chars.
//
// Usage:
//
//   import { freshWorkstream } from "./_fixture.js";
//
//   beforeEach(() => {
//     workstream = freshWorkstream("wait");   // → "wait-l8z-mwj1k7-7d2"
//     session = `mu-${workstream}`;            // → "mu-wait-l8z-mwj1k7-7d2"
//   });
//
// The companion test/_env.ts pollUntil() pairs with this — together
// they replace the older "static fixture name + fixed sleep" pattern
// the suite grew from.
//
// Rationale lives in the bug_test_suite_flake_leaks_isolation task
// notes (Layer 1 of the three-layer fix).

/**
 * Produce a workstream name that's unique across:
 *
 *   - this process (random suffix; nanosecond timestamp is overkill).
 *   - concurrent processes (`process.pid` keeps two `npm test` runs
 *     on the same machine from colliding).
 *   - cross-machine reuse if the same temp DB ever escaped (random
 *     suffix is the belt; pid is the suspenders).
 *
 * The resulting name fits in the 32-char workstream-name DB column
 * (we deliberately keep the generated suffix short — 3 + 1 + 6 + 1 +
 * 6 = 17 chars worst-case, leaving 15 for the caller's prefix).
 *
 * NOTE: tmux session-name length is also bounded; the user-visible
 * `mu-` prefix adds 3, so the effective cap is 29 — still more than
 * the 17 we generate. Any prefix longer than ~12 chars and you risk
 * truncation surprises elsewhere; keep prefixes terse.
 */
export function freshWorkstream(prefix: string): string {
  const pid = process.pid.toString(36);
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `${prefix}-${pid}-${ts}-${rand}`;
}
