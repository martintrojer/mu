import { cpus } from "node:os";
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
 * Derived from the machine rather than pinned: 8 was the measurement, not a
 * tuned optimum, and a hard-coded worker count is how a config stops matching
 * the box it runs on. Setting these to `undefined` does NOT work -- mergeConfig
 * keeps the inherited value, so the cap survived and the suite still took 188s.
 * The override has to be a real number.
 */
const workers = Math.max(2, Math.min(8, Math.floor((cpus().length || 4) / 2)));

export default mergeConfig(baseConfig, {
  test: {
    exclude: ["**/*.integration.test.ts", "**/*.smoke.test.ts"],
    maxWorkers: workers,
    minWorkers: workers,
  },
});
