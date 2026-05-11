// Unit tests for the allowlist policy in test/_global-teardown.ts
// (round-3 Part B). The policy itself is a pure helper —
// `sessionsToKill(allMuSessions, allowlist)` — so we exercise it
// directly without touching real tmux, real DBs, or vitest hooks.
//
// What we verify:
//
//   1. Pre-existing sessions on the user's default socket are NEVER
//      killed, even if their bare name overlaps with a test fixture
//      name (the original failure mode: the regex sweep killed
//      `mu-acc-foo` but never `mu-alpha`; the allowlist must protect
//      `mu-alpha` if it predates the suite).
//
//   2. User-DB workstreams are protected by `mu-<name>` mapping —
//      `tui-impl` workstream protects the `mu-tui-impl` session.
//
//   3. Anything else starting with `mu-` is killed (the leak from
//      bug_test_flake_round_3: bare-name test sessions that bypassed
//      the private socket).
//
//   4. Non-`mu-` sessions are never considered (the helper takes
//      pre-filtered `mu-*` sessions; this just documents the contract).
//
// We don't try to test `snapshotPreexistingSessions` /
// `readUserWorkstreamsFromDb` here — those are I/O wrappers and
// are exercised by the suite running them on every `npm test`.

import { describe, expect, it } from "vitest";
import { sessionsToKill } from "./_global-teardown.js";

describe("global-teardown allowlist sweep policy", () => {
  it("kills nothing when every session is in the allowlist", () => {
    const allowlist = new Set(["mu-tui-impl", "mu-feedback", "mu-someother"]);
    const sessions = ["mu-tui-impl", "mu-feedback", "mu-someother"];
    expect(sessionsToKill(sessions, allowlist)).toEqual([]);
  });

  it("protects pre-existing sessions whose bare name overlaps a test fixture", () => {
    // The user manually created `mu-alpha` BEFORE running `npm test`.
    // The previous regex sweep would have left it alone (no trailing
    // dash); the allowlist sweep must also leave it alone (it's in
    // the snapshot).
    const allowlist = new Set(["mu-alpha", "mu-tui-impl"]);
    const sessions = ["mu-alpha", "mu-tui-impl"];
    expect(sessionsToKill(sessions, allowlist)).toEqual([]);
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
    // If both PRE-EXISTING and DB-read produce empty sets (no user
    // tmux server, no user DB), the suite is the only thing producing
    // mu-* sessions and they're all leaked-by-definition.
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
