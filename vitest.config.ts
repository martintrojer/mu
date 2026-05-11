import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: {
        // Sequential execution (single worker fork) for the
        // integration tests. The full suite shares a single user
        // tmux server: when forks run in parallel, tmux
        // command-mode (`tmux -C` style new-session / kill-session
        // / list-panes) calls from multiple test workers contend
        // on the same socket and stall each other for tens of
        // seconds at a time. The cross-workstream reaper test
        // (testreview_wait_5s_default_timeout_flake) was the
        // canonical victim: 431ms in isolation, 30s+ in parallel.
        // We pay ~30-90s of wall-clock for the whole suite to
        // get a deterministic green; the alternative (skipping
        // tmux integration in CI) erodes the "4-green-before-
        // commit" gate.
        singleFork: true,
      },
    },
    // Layer 2 of bug_test_suite_flake_leaks_isolation: a hook that
    // runs ONCE after the full suite finishes, sweeping any leaked
    // tmux sessions whose names match the integration-fixture
    // prefixes. Per-test afterEach hooks already kill the session
    // they own, but a kill -9 / SIGINT / OOM mid-suite skips them.
    // The teardown is the safety net until Layer 3 (dedicated
    // `tmux -L <socket>` per integration suite) lands and renders
    // it obsolete.
    globalSetup: ["./test/_global-teardown.ts"],
    // Per-fork pre-test setup: scrub MU_* env vars inherited from
    // the parent shell so SDK-level overrides (MU_PI_COMMAND,
    // MU_IDLE_THRESHOLD_MS, …) can't silently change behaviour
    // underneath tests. See test/_setup.ts for the rationale and
    // the allowlist (MU_TMUX_SOCKET is preserved). Layer "test" of
    // bug_test_flake_round_2.
    setupFiles: ["./test/_setup.ts"],
    // Belt-and-suspenders for tmux-fan-out integration tests:
    // many tests in test/*.integration.test.ts spawn real tmux
    // panes + sh subprocesses and then poll/wait for state to
    // propagate (reaper flips, pane death, claim CAS). In isolation
    // each one finishes in <2s, but full-suite parallel forks + a
    // loaded CI box can push individual interactions past vitest's
    // 5000ms default and trigger spurious "Test timed out"
    // failures (testreview_wait_5s_default_timeout_flake). 30000ms
    // is ~15x the observed isolation cost — enough headroom that
    // a real hang still fails fast, but transient load doesn't
    // mask real signal. Per-test `{ timeout: N }` overrides this
    // when a single test legitimately needs longer.
    testTimeout: 30000,
  },
});
