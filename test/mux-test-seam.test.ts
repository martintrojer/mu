// Tests for the mux TEST SEAM itself (test/_mux.ts).
//
// Test infrastructure that silently does the wrong thing is worse than
// none: a harness that stubs herdr while running tmux makes assertions
// pass for the wrong reason, and a safety guard nobody has exercised is
// a comment with extra steps. So the seam gets the same treatment as
// production code.
//
// The herdr-safety half is the important half. Those assertions are the
// executable form of "never touch the user's default herdr session".

import { afterEach, describe, expect, it } from "vitest";
import { listSessions } from "../src/mux/herdr.js";
import { NoMultiplexerError } from "../src/mux/types.js";
import { activeMux } from "../src/mux.js";
import { listSessions as tmuxListSessions } from "../src/tmux.js";
import { withEnv } from "./_env.js";
import {
  assertHerdrIsolated,
  freshHerdrSession,
  HerdrTestSafetyError,
  herdrTestExec,
  installMux,
  installUnreachableMux,
  type MuxHarness,
  tmuxIntegrationAvailable,
} from "./_mux.js";
import { STATUS_RUNNING, WORKSPACE_LIST } from "./_mux-fixtures.js";

const MU_HERDR_SESSION = "MU_HERDR_SESSION";

let harness: MuxHarness | undefined;

afterEach(() => {
  harness?.restore();
  harness = undefined;
});

// ─── One call installs backend + executor ──────────────────────────────

describe("installMux wires the backend and its executor together", () => {
  it("selects herdr AND stubs the herdr executor in one call", async () => {
    harness = installMux("herdr", [["workspace list", WORKSPACE_LIST]]);
    // Backend selection took effect...
    expect((await activeMux()).name).toBe("herdr");
    // ...and the executor the backend actually uses is the stub.
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });

  it("selects tmux AND stubs the tmux executor in one call", async () => {
    harness = installMux("tmux", [["list-sessions", "mu-alpha\nmu-beta\n"]]);
    expect((await activeMux()).name).toBe("tmux");
    expect(await tmuxListSessions()).toEqual([{ name: "mu-alpha" }, { name: "mu-beta" }]);
  });

  it("records every call in order, with argsOf() sugar", async () => {
    harness = installMux("herdr", [["workspace list", WORKSPACE_LIST]]);
    await listSessions();
    await listSessions();
    expect(harness.calls).toHaveLength(2);
    expect(harness.argsOf(0)).toEqual(["workspace", "list"]);
    expect(harness.argsOf(5)).toBeUndefined();
  });

  it("an unrouted call fails like a substrate error and names the command", async () => {
    // Not a throw: the code under test must see what a real failure
    // looks like. The stderr names the route the test forgot.
    harness = installMux("herdr", []);
    await expect(listSessions()).rejects.toThrow(/unrouted: workspace list/);
  });

  it("takes a function for stateful or must-not-be-called stubs", async () => {
    let hits = 0;
    harness = installMux("herdr", async () => {
      hits++;
      return { stdout: WORKSPACE_LIST, stderr: "", exitCode: 0 };
    });
    await listSessions();
    expect(hits).toBe(1);
  });

  it("longest-prefix-first ordering lets a narrow route beat a broad one", async () => {
    harness = installMux("herdr", [
      ["workspace list --foo", '{"result":{"workspaces":[]}}'],
      ["workspace list", WORKSPACE_LIST],
    ]);
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });
});

// ─── Teardown is a single, idempotent call ─────────────────────────────

describe("restore() is one teardown for both seams", () => {
  it("restores the backend so the next test re-detects", async () => {
    const h = installMux("herdr", [["status", STATUS_RUNNING]]);
    expect((await activeMux()).name).toBe("herdr");
    h.restore();
    // resetMux() ran, so activeMux() is no longer pinned to herdr.
    // MU_MUX drives detection deterministically without a real mux.
    await withEnv("MU_MUX", "tmux", async () => {
      expect((await activeMux()).name).toBe("tmux");
    });
  });

  it("is idempotent — a double restore cannot clobber the next harness", async () => {
    const h = installMux("herdr", [["workspace list", WORKSPACE_LIST]]);
    h.restore();
    harness = installMux("herdr", [["workspace list", WORKSPACE_LIST]]);
    // The stale handle's second restore() must be a no-op, or it would
    // reset the executor the CURRENT test just installed.
    h.restore();
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });
});

// ─── Unreachable-mux stub ──────────────────────────────────────────────

describe("installUnreachableMux models a box with no multiplexer", () => {
  it("every method rejects with the supplied error", async () => {
    const unreachable = installUnreachableMux("tmux", () => new NoMultiplexerError(["tmux"]));
    try {
      const mux = await activeMux();
      await expect(mux.listSessions()).rejects.toBeInstanceOf(NoMultiplexerError);
      await expect(mux.paneExists("%1")).rejects.toBeInstanceOf(NoMultiplexerError);
    } finally {
      unreachable.restore();
    }
  });

  it("keeps the backend NAME, so name-dependent branches still work", async () => {
    const unreachable = installUnreachableMux("herdr", () => new NoMultiplexerError(["herdr"]));
    try {
      expect((await activeMux()).name).toBe("herdr");
    } finally {
      unreachable.restore();
    }
  });
});

// ─── The herdr blast shield ────────────────────────────────────────────
//
// These are the tests that keep a future integration test from
// destroying the user's real panes.

describe("assertHerdrIsolated refuses to run without a private session", () => {
  it("throws when MU_HERDR_SESSION is unset", async () => {
    await withEnv(MU_HERDR_SESSION, undefined, async () => {
      expect(() => assertHerdrIsolated()).toThrow(HerdrTestSafetyError);
      expect(() => assertHerdrIsolated()).toThrow(/must name a private test session/);
    });
  });

  it("throws on the DEFAULT session — the user's real panes live there", async () => {
    await withEnv(MU_HERDR_SESSION, "default", async () => {
      expect(() => assertHerdrIsolated()).toThrow(HerdrTestSafetyError);
    });
  });

  it("throws on empty string, which herdr treats as the default", async () => {
    await withEnv(MU_HERDR_SESSION, "", async () => {
      expect(() => assertHerdrIsolated()).toThrow(HerdrTestSafetyError);
    });
  });

  it("returns the session name when properly isolated", async () => {
    await withEnv(MU_HERDR_SESSION, "mu-test-abc", async () => {
      expect(assertHerdrIsolated()).toBe("mu-test-abc");
    });
  });
});

describe("herdrTestExec refuses server-fatal verbs", () => {
  // Note these run with a VALID isolated session set: the point is that
  // isolation alone is not sufficient. `herdr server stop` is
  // shared-fate — mu cannot rely on it being session-scoped — so it is
  // banned outright, not merely redirected.
  const fatal = ["server stop", "server restart", "server kill"];

  for (const verb of fatal) {
    it(`refuses "herdr ${verb}" even inside an isolated session`, async () => {
      await withEnv(MU_HERDR_SESSION, "mu-test-isolated", async () => {
        await expect(herdrTestExec(verb.split(" "))).rejects.toBeInstanceOf(HerdrTestSafetyError);
        await expect(herdrTestExec(verb.split(" "))).rejects.toThrow(/takes down the server/);
      });
    });
  }

  it("refuses ANY command when isolation is missing, before spawning", async () => {
    // The guard must fire on the innocuous commands too — that is what
    // makes it impossible for a forgetful test to reach the default
    // server at all. `pane list` never runs here.
    await withEnv(MU_HERDR_SESSION, undefined, async () => {
      await expect(herdrTestExec(["pane", "list"])).rejects.toBeInstanceOf(HerdrTestSafetyError);
    });
  });
});

describe("integration-tier gates", () => {
  it("tmux gate follows the $TMUX convention", async () => {
    await withEnv("TMUX", undefined, async () => {
      expect(tmuxIntegrationAvailable()).toBe(false);
    });
    await withEnv("TMUX", "/tmp/tmux-1000/default,123,0", async () => {
      expect(tmuxIntegrationAvailable()).toBe(true);
    });
  });

  it("freshHerdrSession is unique per call and never 'default'", () => {
    const a = freshHerdrSession();
    const b = freshHerdrSession();
    expect(a).not.toBe(b);
    expect(a.startsWith("mu-test-")).toBe(true);
    // Feeding it to the guard must always pass.
    expect(() => {
      process.env[MU_HERDR_SESSION] = a;
      try {
        assertHerdrIsolated();
      } finally {
        delete process.env[MU_HERDR_SESSION];
      }
    }).not.toThrow();
  });
});
