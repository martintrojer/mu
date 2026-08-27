// Call sites go through `activeMux()`, and they split cleanly into
// LOAD-BEARING and BEST-EFFORT.
//
// The distinction is the whole point of the migration. With a second
// backend in play, "no multiplexer reachable" stops being a
// misconfigured-box edge case and becomes a routine state (the user
// has herdr, mu detected tmux, or neither is running). So:
//
//   - Load-bearing (spawn / send / read / kill / session create):
//     `NoMultiplexerError` must propagate. handle() maps it to exit 5.
//   - Best-effort (identity, decoration, liveness hints, listings):
//     must degrade. A missing mux may not fail the verb.
//
// Both directions are tested by installing a backend whose every method
// rejects with NoMultiplexerError — the observable behaviour of a box
// with no multiplexer, without needing one absent.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent, readAgent, refreshAgentTitle, sendToAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { NoMultiplexerError, resetMux, setMuxForTests } from "../src/mux.js";
import { reconcile } from "../src/reconcile.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream, listWorkstreams, summarizeWorkstream } from "../src/workstream.js";
import { installUnreachableMux } from "./_mux.js";

let tempDir: string;
let db: Db;
let unreachable: { restore(): void };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-mux-callsites-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  // Every method rejects the way `activeMux()` itself would on a box
  // with nothing installed, so a call site's try/catch (or lack of one)
  // is what the test observes.
  unreachable = installUnreachableMux("tmux", () => new NoMultiplexerError(["tmux"]));
});

afterEach(() => {
  unreachable.restore();
  resetTmuxExecutor();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function seedAgent(workstream: string, name = "worker-1"): void {
  ensureWorkstream(db, workstream);
  insertAgent(db, { name, workstream, paneId: "%15", status: "free" });
}

describe("best-effort call sites degrade when no mux is reachable", () => {
  it("refreshAgentTitle swallows it — pane titles are decorative", async () => {
    seedAgent("alpha");
    await expect(refreshAgentTitle(db, "worker-1", "alpha")).resolves.toBeUndefined();
  });

  it("summarizeWorkstream still answers, reporting the session as not alive", async () => {
    ensureWorkstream(db, "alpha");
    const summary = await summarizeWorkstream(db, { workstream: "alpha" });
    // DB truth survives; only the mux-sourced decoration degrades.
    expect(summary.name).toBe("alpha");
    expect(summary.muxAlive).toBe(false);
  });

  it("listWorkstreams falls back to the registered set instead of throwing", async () => {
    ensureWorkstream(db, "alpha");
    ensureWorkstream(db, "beta");
    const names = (await listWorkstreams(db)).map((w) => w.name);
    expect(names).toEqual(["alpha", "beta"]);
  });
});

describe("load-bearing call sites propagate NoMultiplexerError", () => {
  it("sendToAgent throws — a send that reaches no pane is a failed send", async () => {
    seedAgent("alpha");
    await expect(sendToAgent(db, "worker-1", "hi", { workstream: "alpha" })).rejects.toBeInstanceOf(
      NoMultiplexerError,
    );
  });

  it("readAgent throws — the scrollback IS the verb's output", async () => {
    seedAgent("alpha");
    await expect(readAgent(db, "worker-1", { workstream: "alpha" })).rejects.toBeInstanceOf(
      NoMultiplexerError,
    );
  });

  it("reconcile throws rather than reaping every agent as a ghost", async () => {
    // The dangerous degradation: treating an unreachable mux as "zero
    // panes exist" would prune every registered agent and reap its
    // in-progress tasks. Failing loud is the only safe answer.
    seedAgent("alpha");
    await expect(reconcile(db, { workstream: "alpha" })).rejects.toBeInstanceOf(NoMultiplexerError);
  });
});

describe("MU_MUX is load-bearing now that call sites route through activeMux()", () => {
  it("an unknown MU_MUX value fails a real verb, not just detectMux()", async () => {
    // Before the migration this was inert: every call site imported
    // src/tmux.ts directly, so `MU_MUX=nope mu agent read ...` ran
    // happily on tmux. Regression guard for exactly that.
    setMuxForTests(undefined);
    resetMux();
    const key = "MU_MUX";
    process.env[key] = "nope";
    try {
      seedAgent("alpha");
      await expect(readAgent(db, "worker-1", { workstream: "alpha" })).rejects.toThrow(
        /unknown mux backend: nope/,
      );
    } finally {
      delete process.env[key];
      resetMux();
    }
  });

  it("MU_MUX=tmux routes a verb through the tmux backend's executor", async () => {
    setMuxForTests(undefined);
    resetMux();
    const key = "MU_MUX";
    process.env[key] = "tmux";
    const seen: string[][] = [];
    setTmuxExecutor(async (args) => {
      seen.push([...args]);
      return { stdout: "scrollback", stderr: "", exitCode: 0 };
    });
    try {
      seedAgent("alpha");
      const text = await readAgent(db, "worker-1", { workstream: "alpha" });
      expect(text).toBe("scrollback");
      expect(seen[0]?.[0]).toBe("capture-pane");
    } finally {
      delete process.env[key];
      resetMux();
    }
  });
});
