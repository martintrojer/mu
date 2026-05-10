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
