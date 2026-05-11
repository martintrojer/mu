// CLI-level tests for `mu agent spawn`'s pre-flight PATH check + the
// extended startup-error scrollback scanner + env-var attribution in
// the success line. Source: feedback ws task
// `fb_agent_spawn_no_validation`.
//
// The dogfood report: `mu agent spawn worker-1 --cli pi-meta` on a host
// where `pi-meta` wasn't on PATH printed `Spawned worker-1 (pi-meta)`
// and the pane immediately died with `command not found`; the existing
// 1.5s liveness check sometimes missed it (shells stay alive past a
// failed exec). Three fixes:
//
//   PART A — pre-spawn PATH check via `checkCommandResolvable`. Throws
//             `AgentSpawnCliNotFoundError` BEFORE prestageWorkspace so
//             a typo never creates an orphan workspace dir.
//   PART B — extra patterns added to the existing scrollback scanner
//             (`command not found`, `No such file or directory`) to
//             catch the post-spawn variant that slips past PART A
//             (e.g. when --command opt-out, or the spawned shell's
//             PATH differs from mu's).
//   PART C — surface the resolved command in the spawn success line:
//             `Spawned worker-1 (pi-meta via $MU_PI_META_COMMAND)`
//             when the CLI was resolved via env var, so config issues
//             are visible without `mu agent show`.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  type CommandResolver,
  checkCommandResolvable,
  envVarNameForCli,
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { hasNextSteps } from "../src/output.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { listWorkspaces, workspacePath } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";
import { type MockState, freshMockState, mockTmux } from "./_verbs-mock.js";

// ─── Helpers ──────────────────────────────────────────────────────────

/** Build a CommandResolver that returns ok=true for binaries in
 *  `present` and ok=false for everything else. Mirrors the shape the
 *  real `command -v` resolver produces. */
function fakeResolver(present: ReadonlySet<string>): CommandResolver {
  return async (command: string) => {
    const binary = command.trim().split(/\s+/)[0] ?? "";
    if (present.has(binary)) {
      return { ok: true, binary, resolvedPath: `/fake/bin/${binary}` };
    }
    return { ok: false, binary };
  };
}

/** Mutate process.env[key] for the duration of `fn` and restore. */
async function withEnv(
  key: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

// ─── Setup / teardown ────────────────────────────────────────────────

let tempDir: string;
let dbPath: string;
let db: Db;
let state: MockState;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-spawn-validation-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  state = freshMockState();
  resetTmuxExecutor();
  setSleepForTests(async () => {});
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
  resetCommandResolverForTests();
  // Tests poke MU_SPAWN_LIVENESS_MS via runCli's child env on some
  // paths; ensure the parent process env is clean between cases.
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
});

// ─── Pure helper: envVarNameForCli ───────────────────────────────────

describe("envVarNameForCli", () => {
  it("uppercases and underscore-substitutes the cli key", () => {
    expect(envVarNameForCli("pi")).toBe("MU_PI_COMMAND");
    expect(envVarNameForCli("pi-meta")).toBe("MU_PI_META_COMMAND");
    expect(envVarNameForCli("claude")).toBe("MU_CLAUDE_COMMAND");
    // hyphens (not legal in env var names) get rewritten to underscores
    expect(envVarNameForCli("pi-mini-fast")).toBe("MU_PI_MINI_FAST_COMMAND");
  });
});

// ─── checkCommandResolvable seam ─────────────────────────────────────

describe("checkCommandResolvable", () => {
  it("honours setCommandResolverForTests", async () => {
    setCommandResolverForTests(fakeResolver(new Set(["pi"])));
    await expect(checkCommandResolvable("pi")).resolves.toMatchObject({
      ok: true,
      binary: "pi",
      resolvedPath: "/fake/bin/pi",
    });
    await expect(checkCommandResolvable("does-not-exist")).resolves.toMatchObject({
      ok: false,
      binary: "does-not-exist",
    });
  });

  it("only inspects the FIRST whitespace-separated token", async () => {
    setCommandResolverForTests(fakeResolver(new Set(["pi-meta"])));
    // Args after the binary are irrelevant to the lookup — what we
    // check is whether the binary is on PATH.
    await expect(
      checkCommandResolvable("pi-meta --no-solo --model sonnet:high"),
    ).resolves.toMatchObject({ ok: true, binary: "pi-meta" });
  });

  it("resetCommandResolverForTests restores the default resolver", async () => {
    setCommandResolverForTests(async () => ({ ok: true, binary: "fake" }));
    resetCommandResolverForTests();
    // After reset we hit the real `command -v`; on a normal *nix
    // dev box `/bin/sh` exists. We don't care about the resolved
    // path — just that the default isn't our fake any more.
    const r = await checkCommandResolvable("/bin/sh");
    expect(r.ok).toBe(true);
  });
});

// ─── Part A: pre-flight PATH check via spawnAgent ───────────────────

describe("spawnAgent — pre-flight PATH check (Part A)", () => {
  it("throws AgentSpawnCliNotFoundError when --cli's binary is not on PATH", async () => {
    setCommandResolverForTests(fakeResolver(new Set([]) /* nothing on PATH */));
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);

    let caught: unknown;
    try {
      await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "does-not-exist" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentSpawnCliNotFoundError);
    if (!(caught instanceof AgentSpawnCliNotFoundError)) throw new Error("unreachable");
    expect(caught.cli).toBe("does-not-exist");
    expect(caught.binary).toBe("does-not-exist");
    expect(caught.envVarChecked).toBe("MU_DOES_NOT_EXIST_COMMAND");

    // Pre-flight runs BEFORE prestageWorkspace and BEFORE any tmux
    // call. The mock tmux executor must have seen zero calls.
    expect(calls).toEqual([]);
    // No DB row was inserted.
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("does NOT orphan a workspace when the pre-flight check fails", async () => {
    // Real workspace-creating spawn path — exercises the rationale:
    // the pre-flight has to fire BEFORE prestageWorkspace, otherwise
    // a typo in --cli leaves an orphan workspace dir behind.
    const stateDir = mkdtempSync(join(tmpdir(), "mu-spawn-validation-state-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "mu-spawn-validation-proj-"));
    writeFileSync(join(projectRoot, "README"), "hello\n");
    process.env.MU_STATE_DIR = stateDir;
    try {
      ensureWorkstream(db, "auth");
      setCommandResolverForTests(fakeResolver(new Set([])));
      const { executor } = mockTmux(state);
      setTmuxExecutor(executor);

      await expect(
        spawnAgent(db, {
          name: "worker-1",
          workstream: "auth",
          cli: "does-not-exist",
          workspace: true,
          workspaceBackend: "none",
          workspaceProjectRoot: projectRoot,
        }),
      ).rejects.toBeInstanceOf(AgentSpawnCliNotFoundError);

      // No workspace row, no workspace dir.
      expect(listWorkspaces(db, "auth")).toEqual([]);
      expect(existsSync(workspacePath("auth", "worker-1"))).toBe(false);
    } finally {
      const key = "MU_STATE_DIR";
      delete process.env[key];
      for (const dir of [stateDir, projectRoot]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it("AgentSpawnCliNotFoundError carries actionable nextSteps (default + env-var + which)", async () => {
    setCommandResolverForTests(fakeResolver(new Set([])));
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);

    let caught: unknown;
    try {
      await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "pi-meta" });
    } catch (err) {
      caught = err;
    }
    expect(hasNextSteps(caught)).toBe(true);
    if (!hasNextSteps(caught)) throw new Error("unreachable");
    const commands = caught
      .errorNextSteps()
      .map((s) => s.command)
      .join("\n");
    // Three required hints from the spec.
    expect(commands).toMatch(/--cli pi\b/);
    expect(commands).toMatch(/MU_PI_META_COMMAND/);
    expect(commands).toMatch(/which pi pi-meta claude codex/);
  });

  it("succeeds when the resolver reports the binary IS on PATH (--cli pi happy path)", async () => {
    setCommandResolverForTests(fakeResolver(new Set(["pi"])));
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "pi" });
    expect(agent.name).toBe("worker-1");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("skips the pre-flight when --command was supplied explicitly (operator opt-out)", async () => {
    // Even though the resolver would say 'no such binary', the
    // explicit --command bypasses the pre-flight: the operator
    // signed off on the literal command they want spawned. The
    // post-spawn liveness scan (Part B) is the safety net for those.
    setCommandResolverForTests(fakeResolver(new Set([])));
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      cli: "pi",
      command: "pi --some-wrapper-that-the-resolver-cant-parse",
    });
    expect(agent.name).toBe("worker-1");
  });

  it("MU_<UPPER_CLI>_COMMAND override is checked: a present alias passes pre-flight", async () => {
    // Set MU_PI_COMMAND=/bin/echo and have the resolver report
    // /bin/echo present. spawnAgent should resolve via the env var,
    // pre-flight that resolved binary, and succeed.
    setCommandResolverForTests(fakeResolver(new Set(["/bin/echo"])));
    await withEnv("MU_PI_COMMAND", "/bin/echo", async () => {
      const { executor } = mockTmux(state);
      setTmuxExecutor(executor);
      const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "pi" });
      expect(agent.name).toBe("worker-1");
    });
  });

  it("MU_<UPPER_CLI>_COMMAND override pointing at a missing binary fails pre-flight", async () => {
    setCommandResolverForTests(
      fakeResolver(new Set(["pi"])) /* `pi` would pass; the override won't */,
    );
    await withEnv("MU_PI_COMMAND", "pi-typoed", async () => {
      const { executor } = mockTmux(state);
      setTmuxExecutor(executor);

      let caught: unknown;
      try {
        await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "pi" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentSpawnCliNotFoundError);
      if (!(caught instanceof AgentSpawnCliNotFoundError)) throw new Error("unreachable");
      // The diagnostic surfaces the resolved binary (the env-var
      // value), not the bare cli key — that's what the operator
      // needs to see to fix it.
      expect(caught.binary).toBe("pi-typoed");
      // env var is the conventional name for the cli key.
      expect(caught.envVarChecked).toBe("MU_PI_COMMAND");
    });
  });
});

// ─── Part B: extended scrollback patterns ────────────────────────────

describe("scrollback scanner — Part B patterns", () => {
  /** Inject the given scrollback into every existing pane during the
   *  spawn liveness sleep. Mirrors test/verbs-spawn.test.ts. */
  function injectScrollbackOnSleep(content: string): void {
    setSleepForTests(async () => {
      for (const pane of state.panes.values()) {
        pane.scrollback = content;
      }
    });
  }

  beforeEach(() => {
    // Pre-flight off for these — we want the spawn to reach the
    // post-spawn liveness scan.
    setCommandResolverForTests(fakeResolver(new Set(["pi"])));
  });

  it.each([
    // Spec-listed patterns (curated short list to keep false-positive
    // risk low; see STARTUP_ERROR_PATTERNS in src/agents/spawn.ts):
    //   /command not found/i
    //   /No such file or directory/i
    ["zsh: command not found: pi-meta"],
    ["bash: pi-meta: command not found"],
    ["sh: pi-meta: No such file or directory"],
  ])("detects shell error: %s", async (line) => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    injectScrollbackOnSleep(`${line}\n$ `);

    let caught: unknown;
    try {
      await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "pi" });
    } catch (err) {
      caught = err;
    }
    // The shell's `command not found` (or sh's `not found`) and
    // `No such file or directory` map to the same post-spawn class
    // as the auth-failure scan: AgentSpawnStartupError. (Distinct
    // from the pre-flight AgentSpawnCliNotFoundError above.)
    expect(caught).toBeInstanceOf(AgentSpawnStartupError);
  });

  it("clean scrollback (no shell-error markers) does NOT trip the scanner", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    injectScrollbackOnSleep("pi v0.5.0\nready\n> ");

    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "pi" });
    expect(agent.name).toBe("worker-1");
  });
});

// ─── Part C: env-var attribution in the spawn success line ───────────

describe("`mu agent spawn` — env-var attribution in success line (Part C)", () => {
  beforeEach(() => {
    // CLI test path goes through buildProgram() + parseAsync() in a
    // child-style harness (runCli). The CLI path opens its own DB
    // via MU_DB_PATH; this test's outer `db` is unused inside runCli
    // beyond ensuring the file/schema exist.
    db.close();
    // Fresh state for the in-process harness.
    state = freshMockState();
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    // Make every PATH check pass — we're testing display text, not
    // resolution. Specific binaries we'll spawn via cli:
    setCommandResolverForTests(
      fakeResolver(new Set(["pi", "pi-meta", "/bin/echo", "does-not-exist"])),
    );
    // Skip the 1.5s post-spawn sleep so the test runs fast.
    process.env.MU_SPAWN_LIVENESS_MS = "0";
  });

  it("shows '(via $MU_<KEY>_COMMAND)' when the resolution came from an env var", async () => {
    // --cli xxx + MU_XXX_COMMAND=/bin/echo → resolves, success line
    // mentions $MU_XXX_COMMAND. (`xxx` chosen so nothing collides
    // with a pre-existing env var on the host.)
    await withEnv("MU_XXX_COMMAND", "/bin/echo", async () => {
      const r = await runCli(["agent", "spawn", "worker-1", "-w", "auth", "--cli", "xxx"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.exitCode === null || r.exitCode === 0).toBe(true);
      expect(r.stdout).toContain("Spawned");
      expect(r.stdout).toContain("worker-1");
      expect(r.stdout).toContain("xxx");
      // The env-var attribution is the load-bearing assertion: the
      // success line must name the env var the operator should
      // grep / unset to fix a stale alias.
      expect(r.stdout).toContain("$MU_XXX_COMMAND");
    });
  });

  it("does NOT mention any env var when the bare cli name was used (no override)", async () => {
    // No MU_PI_COMMAND set → resolution falls through to the bare
    // 'pi' name. The success line should be 'Spawned worker-1 (pi)'
    // with no env-var suffix.
    await withEnv("MU_PI_COMMAND", undefined, async () => {
      const r = await runCli(["agent", "spawn", "worker-1", "-w", "auth", "--cli", "pi"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.exitCode === null || r.exitCode === 0).toBe(true);
      expect(r.stdout).toContain("Spawned");
      expect(r.stdout).toContain("(pi)");
      expect(r.stdout).not.toContain("$MU_PI_COMMAND");
      expect(r.stdout).not.toContain("via $");
    });
  });

  it("--json carries `resolvedFromEnvVar` when the override came from an env var", async () => {
    await withEnv("MU_XXX_COMMAND", "/bin/echo", async () => {
      const r = await runCli(
        ["agent", "spawn", "worker-1", "-w", "auth", "--cli", "xxx", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const env = JSON.parse(r.stdout);
      expect(env.resolvedFromEnvVar).toBe("MU_XXX_COMMAND");
      expect(env.resolvedCommand).toBe("/bin/echo");
      expect(env.commandOverridden).toBe(true);
    });
  });

  it("--json omits `resolvedFromEnvVar` on the bare-cli (no-override) path", async () => {
    await withEnv("MU_PI_COMMAND", undefined, async () => {
      const r = await runCli(
        ["agent", "spawn", "worker-1", "-w", "auth", "--cli", "pi", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const env = JSON.parse(r.stdout);
      expect(env.resolvedFromEnvVar).toBeUndefined();
      expect(env.commandOverridden).toBe(false);
    });
  });

  it("`mu agent spawn --cli does-not-exist` exits non-zero and refuses (Part A end-to-end)", async () => {
    // Simulate an empty PATH for this one case so the pre-flight
    // refuses. `does-not-exist` is intentionally outside our
    // present-set above.
    setCommandResolverForTests(fakeResolver(new Set(["pi"])));
    const r = await runCli(
      ["agent", "spawn", "worker-1", "-w", "auth", "--cli", "does-not-exist"],
      dbPath,
    );
    // No unhandled error — the typed AgentSpawnCliNotFoundError went
    // through the handle() → emitError() pipeline.
    expect(r.error).toBeUndefined();
    // Refused → non-zero exit. Spec only requires != 0; the actual
    // code is the substrate-class lane (1).
    expect(r.exitCode).not.toBeNull();
    expect(r.exitCode).not.toBe(0);
    // Diagnostic-first: stderr names the missing binary AND points
    // at the env-var fix.
    expect(r.stderr).toContain("does-not-exist");
    expect(r.stderr).toContain("MU_DOES_NOT_EXIST_COMMAND");
  });
});
