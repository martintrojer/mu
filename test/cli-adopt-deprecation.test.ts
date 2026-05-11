// CLI-level tests for `mu adopt` → `mu agent adopt` rename
// (mu_adopt_should_be_mu_agent_adopt_for).
//
// Operator decision (option 1): add `mu agent adopt` as the canonical
// form, keep `mu adopt` as a deprecated alias until v0.5. The legacy
// alias prints a one-line stderr hint; --json suppresses it. Both
// forms call the same `cmdAdopt` handler so behaviour is identical
// otherwise.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";
import { type MockState, freshMockState, mockTmux } from "./_verbs-mock.js";

describe("mu adopt deprecation alias", () => {
  let tempDir: string;
  let dbPath: string;
  let state: MockState;

  function seedOrphanPane(opts: {
    sessionName: string;
    title: string;
    paneId?: string;
  }): { paneId: string } {
    state.sessions.add(opts.sessionName);
    const windowId = `@${state.nextWindowId++}`;
    const paneId = opts.paneId ?? `%${state.nextPaneId++}`;
    state.windows.set(opts.sessionName, [{ id: windowId, name: "main" }]);
    state.panes.set(paneId, {
      windowId,
      paneId,
      title: opts.title,
      command: "pi",
    });
    return { paneId };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-adopt-deprec-"));
    dbPath = join(tempDir, "mu.db");
    const db: Db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
    state = freshMockState();
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
  });

  afterEach(() => {
    resetTmuxExecutor();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("`mu adopt` still works and prints the deprecation hint to stderr", async () => {
    const { paneId } = seedOrphanPane({ sessionName: "mu-test", title: "worker-1" });
    const r = await runCli(["adopt", paneId, "-w", "test"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode === null || r.exitCode === 0).toBe(true);
    // Stderr carries the deprecation hint; stdout does not.
    expect(r.stderr).toContain("deprecated:");
    expect(r.stderr).toContain("mu agent adopt");
    expect(r.stderr).toContain("v0.5");
    expect(r.stdout).not.toContain("deprecated:");
    // The verb still actually adopted the pane (canonical success line).
    expect(r.stdout).toContain("Adopted ");
    expect(r.stdout).toContain("worker-1");
  });

  it("`mu adopt --json` suppresses the deprecation hint (machine surface stays clean)", async () => {
    const { paneId } = seedOrphanPane({ sessionName: "mu-test", title: "worker-2" });
    const r = await runCli(["adopt", paneId, "-w", "test", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode === null || r.exitCode === 0).toBe(true);
    // No deprecation prose anywhere — stderr should be empty (or at
    // least contain none of the hint words).
    expect(r.stderr).not.toContain("deprecated:");
    expect(r.stderr).not.toContain("mu agent adopt");
    // JSON envelope on stdout, parses cleanly, has the adoption shape.
    const env = JSON.parse(r.stdout);
    expect(env.adopted).toBe(true);
    expect(env.agent.name).toBe("worker-2");
  });

  it("`mu agent adopt` is the canonical form: works AND emits no deprecation hint", async () => {
    const { paneId } = seedOrphanPane({ sessionName: "mu-test", title: "worker-3" });
    const r = await runCli(["agent", "adopt", paneId, "-w", "test"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode === null || r.exitCode === 0).toBe(true);
    expect(r.stderr).not.toContain("deprecated:");
    expect(r.stdout).toContain("Adopted ");
    expect(r.stdout).toContain("worker-3");
  });

  it("`mu agent adopt --json` emits the same envelope as the legacy form", async () => {
    const { paneId } = seedOrphanPane({ sessionName: "mu-test", title: "worker-4" });
    const r = await runCli(["agent", "adopt", paneId, "-w", "test", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode === null || r.exitCode === 0).toBe(true);
    expect(r.stderr).not.toContain("deprecated:");
    const env = JSON.parse(r.stdout);
    expect(env.adopted).toBe(true);
    expect(env.agent.name).toBe("worker-4");
  });

  it("`mu adopt --help` says it's a deprecated alias", async () => {
    const r = await runCli(["adopt", "--help"], dbPath);
    // commander.helpDisplayed lands as exit 0 via classifyCommanderError.
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("deprecated alias");
    expect(r.stdout).toContain("mu agent adopt");
  });

  it("`mu agent adopt --help` carries the canonical (non-deprecated) description", async () => {
    const r = await runCli(["agent", "adopt", "--help"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("Register an existing tmux pane");
    // Canonical form must NOT advertise itself as a deprecated alias.
    expect(r.stdout).not.toContain("deprecated alias");
  });
});
