// Fast-tier unit tests for the cross-process spawn lock primitive.
//
// withSpawnLock serialises the tmux-topology critical section of a
// spawn across separate `mu` processes (keyed on tmux session name) so a
// parallel fan-out can't race `new-session` calls into rolled-back
// losers. See src/agents/spawn-lock.ts and
// bug_parallel_spawn_races_drop_agents.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSpawnLockMeta, withSpawnLock } from "../src/agents/spawn-lock.js";

describe("withSpawnLock", () => {
  let dir: string;
  const key = "MU_STATE_DIR";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-spawnlock-"));
    process.env[key] = dir;
  });

  afterEach(() => {
    delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the critical section and returns its value", async () => {
    const out = await withSpawnLock("mu-scratch", async () => 42);
    expect(out).toBe(42);
  });

  it("releases the lock after the section (next acquire succeeds)", async () => {
    await withSpawnLock("mu-scratch", async () => "first");
    const second = await withSpawnLock("mu-scratch", async () => "second");
    expect(second).toBe("second");
  });

  it("releases the lock even when the section throws", async () => {
    await expect(
      withSpawnLock("mu-scratch", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Lock must be free for the next caller.
    const after = await withSpawnLock("mu-scratch", async () => "ok");
    expect(after).toBe("ok");
  });

  it("serialises concurrent sections on the same session (no overlap)", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const section = async (): Promise<void> => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
    };
    await Promise.all(Array.from({ length: 8 }, () => withSpawnLock("mu-scratch", section)));
    expect(maxConcurrent).toBe(1);
  });

  it("does NOT serialise sections on different sessions (independent locks)", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const section = async (): Promise<void> => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
    };
    await Promise.all([
      withSpawnLock("mu-a", section),
      withSpawnLock("mu-b", section),
      withSpawnLock("mu-c", section),
    ]);
    // Different session keys → no contention → all overlap.
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("records holder metadata while the section runs", async () => {
    await withSpawnLock("mu-scratch", async () => {
      const meta = await readSpawnLockMeta("mu-scratch");
      expect(meta?.pid).toBe(process.pid);
      expect(meta?.session).toBe("mu-scratch");
      expect(typeof meta?.acquiredAt).toBe("string");
    });
    // After release the meta is gone.
    expect(await readSpawnLockMeta("mu-scratch")).toBeNull();
  });

  it("breaks a stale lock from a dead process (staleLockMs=0)", async () => {
    // Hold the lock, then \u2014 while held \u2014 a second caller with
    // staleLockMs=0 should treat it as stale and break in. We assert the
    // second caller completes rather than timing out.
    let innerRan = false;
    await withSpawnLock("mu-scratch", async () => {
      await withSpawnLock(
        "mu-scratch",
        async () => {
          innerRan = true;
        },
        { staleLockMs: 0, acquireTimeoutMs: 2000 },
      );
    });
    expect(innerRan).toBe(true);
  });
});
