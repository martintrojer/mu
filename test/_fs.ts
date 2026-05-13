import { rmSync } from "node:fs";

/**
 * Remove a temp fixture directory with Node's built-in retry loop.
 *
 * Under mu's dogfood workflow, multiple agents often run full vitest
 * suites concurrently on the same machine. VCS tools (especially sl)
 * can leave very short-lived background file activity in fixture dirs;
 * a plain rmSync({recursive, force}) then occasionally throws ENOTEMPTY
 * even though the next attempt succeeds. Keep cleanup deterministic
 * without hiding real leaks: retry ENOTEMPTY/EBUSY briefly, then throw.
 */
export function rmFixtureDir(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}
