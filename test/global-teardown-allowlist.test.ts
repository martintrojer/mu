// Unit tests for the allowlist policy in test/_global-teardown.ts
// (round-4: DB-rooted allowlist). The policy itself is a pure helper —
// `sessionsToKill(allMuSessions, allowlist)` — so we exercise it
// directly without touching real tmux, real DBs, or vitest hooks.
//
// What we verify:
//
//   1. User-DB workstreams are protected by `mu-<name>` mapping —
//      `tui-impl` workstream protects the `mu-tui-impl` session.
//
//   2. Anything else starting with `mu-` is killed (the leak from
//      bug_test_flake_round_3: bare-name test sessions that bypassed
//      the private socket). Round-4: this now includes ad-hoc sessions
//      with no DB row — by design, see
//      bug_test_flake_round_4_self_heal. The pre-existing-snapshot
//      escape hatch was a self-locking trap (test residue at
//      module-load got grandfathered in as protected forever).
//
//   3. Non-`mu-` sessions are never considered (the helper takes
//      pre-filtered `mu-*` sessions; this just documents the contract).
//
// We don't try to test `readUserWorkstreamsFromDb` here — it's an
// I/O wrapper exercised by the suite running it on every `npm test`.

import { describe, expect, it } from "vitest";
import { sessionsToKill } from "./_global-teardown.js";

describe("global-teardown allowlist sweep policy", () => {
  it("kills nothing when every session is in the allowlist", () => {
    const allowlist = new Set(["mu-tui-impl", "mu-feedback", "mu-someother"]);
    const sessions = ["mu-tui-impl", "mu-feedback", "mu-someother"];
    expect(sessionsToKill(sessions, allowlist)).toEqual([]);
  });

  it("protects ad-hoc sessions only when they have a DB row in the allowlist", () => {
    // The user ran `mu workstream init alpha` (DB row exists) and
    // then `tmux new-session -t mu-alpha`. The DB row puts `mu-alpha`
    // in the allowlist; the sweep must not touch it.
    //
    // Contrast with round-3, which ALSO protected an ad-hoc
    // `mu-alpha` session purely because it was visible at
    // module-load time (the "preexisting snapshot" escape hatch).
    // That hatch was removed in round-4 because leftover test
    // residue at module-load got grandfathered in as protected
    // forever. See bug_test_flake_round_4_self_heal.
    const allowlist = new Set(["mu-alpha", "mu-tui-impl"]);
    const sessions = ["mu-alpha", "mu-tui-impl"];
    expect(sessionsToKill(sessions, allowlist)).toEqual([]);
  });

  it("kills ad-hoc sessions with no DB row (round-4 self-heal contract)", () => {
    // Inverse of the previous case: the user did `tmux new-session
    // -t mu-experiment` WITHOUT a `mu workstream init experiment`
    // first. Round-3 would have grandfathered it in (visible at
    // module-load → added to PROTECTED_PREEXISTING_SESSIONS).
    // Round-4 kills it: the DB is the only source of truth for
    // "this is a real workstream the user cares about". Cost is
    // documented in the helper's docstring; workaround is `mu
    // workstream init experiment`.
    const allowlist = new Set(["mu-tui-impl"]); // DB has tui-impl only
    const sessions = ["mu-experiment", "mu-tui-impl"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-experiment"]);
  });

  it("kills bare-name test residue not in the allowlist", () => {
    // The exact failure mode of bug_test_flake_round_3: `mu-alpha`,
    // `mu-demo`, `mu-ws`, etc. created by tests that hardcode short
    // workstream names. None are in the allowlist; all should die.
    const allowlist = new Set(["mu-tui-impl"]);
    const sessions = [
      "mu-alpha",
      "mu-beta",
      "mu-demo",
      "mu-gamma",
      "mu-scratch",
      "mu-ws",
      "mu-ws2",
      "mu-tui-impl",
    ];
    expect(sessionsToKill(sessions, allowlist)).toEqual([
      "mu-alpha",
      "mu-beta",
      "mu-demo",
      "mu-gamma",
      "mu-scratch",
      "mu-ws",
      "mu-ws2",
    ]);
  });

  it("kills regex-prefixed test sessions when not allowlisted", () => {
    // The regression target the original sweep was designed for:
    // `mu-acc-...` from a crashed test/acceptance.test.ts run.
    const allowlist = new Set(["mu-tui-impl"]);
    const sessions = ["mu-acc-h7g8x4", "mu-claim-jh3z9p", "mu-tui-impl"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-acc-h7g8x4", "mu-claim-jh3z9p"]);
  });

  it("treats the empty allowlist as kill-all-mu-sessions (defensive — should never fire in production)", () => {
    // If DB-read produces an empty set (no user DB) and `$MU_SESSION`
    // is unset, the suite is the only thing producing mu-* sessions
    // and they're all leaked-by-definition.
    const allowlist = new Set<string>();
    const sessions = ["mu-foo", "mu-bar"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-foo", "mu-bar"]);
  });

  it("returns the input order (deterministic for the warning message)", () => {
    // The teardown warning lists killed sessions in some order; the
    // tests around it (and humans reading CI logs) appreciate a
    // stable left-to-right list rather than a Set-iteration order.
    const allowlist = new Set(["mu-keep"]);
    const sessions = ["mu-zzz", "mu-keep", "mu-aaa", "mu-mmm"];
    expect(sessionsToKill(sessions, allowlist)).toEqual(["mu-zzz", "mu-aaa", "mu-mmm"]);
  });
});
