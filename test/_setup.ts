// Global per-fork test setup: scrub MU_* env vars at startup.
//
// Why this exists (bug_test_flake_round_2 — Layer "test"):
//
// vitest forks inherit the parent shell's environment. When a
// developer (or the orchestrator agent) runs `npm test` from a
// shell that exports SDK-level env overrides — e.g.
// `MU_PI_COMMAND=pi-meta` (Meta-internal pi wrapper),
// `MU_IDLE_THRESHOLD_MS=60000`, `MU_SEND_DELAY_MS=200`, etc. —
// those values silently change SDK behaviour underneath every test.
//
// Concrete failure that motivated this: 5 cli-agent-spawn-validation
// tests deterministically failed with
// `AgentSpawnCliNotFoundError: --cli pi resolved to binary
//  "pi-meta" which is not on PATH` because MU_PI_COMMAND=pi-meta
// leaked from the orchestrator's shell into vitest. The tests
// themselves are correct — they assume `--cli pi` resolves to bare
// `pi`, which is the documented default — and adding a one-off
// withEnv() to each is fragile (the next env var leaks the same
// way next month).
//
// Belt-and-suspenders solution: nuke EVERY MU_* env var at the
// start of every fork. Tests that genuinely need a specific value
// (`MU_SPAWN_LIVENESS_MS=0`, `MU_STATE_DIR=...`, etc.) opt IN via
// per-test `process.env.X = "..."` or `withEnv()`. This makes the
// baseline a known-clean env regardless of the surrounding shell.
//
// Allowlist:
//   MU_TMUX_SOCKET — set by ./_global-teardown.ts in the main
//     process BEFORE fork spawn (Layer 3 of the prior test-flake
//     bundle). Forks inherit it intentionally so every tmux call
//     routes through the private test server. Wiping it here would
//     drop us back onto the user's default socket and re-introduce
//     the residue + cross-run contention that Layer 3 fixed.
//
// Anything else starting with MU_ goes.

const ALLOWED: ReadonlySet<string> = new Set([
  // Layer-3 test-isolation socket (see _global-teardown.ts).
  "MU_TMUX_SOCKET",
]);

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MU_") && !ALLOWED.has(key)) {
    delete process.env[key];
  }
}
