import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

/**
 * The pre-commit suite: everything that does NOT drive a real tmux server.
 *
 * Runs in PARALLEL, and that is the whole point of this file. The base config
 * pins `maxWorkers: 1` because the integration tests share one user tmux server
 * and contend on its socket -- a real constraint, but one that belongs to the
 * ~9 files that actually spawn panes, not to the other 130. Inheriting the cap
 * here made the fast suite serial for a reason none of its tests have.
 *
 * Measured on this suite, 1998 tests in 130 files:
 *
 *   maxWorkers: 1   255s   (import 135s -- ~1039ms per file, paid one at a time)
 *   maxWorkers: 8    44s   (import 181s, but overlapped)
 *
 * 5.8x, same 1998 passing. The cost was never the tests -- `tests` was 86s of
 * the 255 -- it was module loading serialised behind a one-worker cap. A slow
 * gate is a gate people skip, and this one is run before every commit.
 *
 * `maxWorkers` is deliberately left to vitest's default (CPU-derived) rather
 * than pinned to 8: 8 was the measurement, not a tuned optimum, and hard-coding
 * a worker count is how a config stops matching the machine it runs on.
 */
export default mergeConfig(baseConfig, {
  test: {
    exclude: ["**/*.integration.test.ts", "**/*.smoke.test.ts"],
    maxWorkers: undefined,
    minWorkers: undefined,
  },
});
