// Real cross-process regression for bug_parallel_spawn_races_drop_agents.
//
// The bug: every `mu` invocation is a separate process, so a parallel
// fan-out —
//
//   for n in 1..6; do mu agent spawn scout-$n -w scratch & done; wait
//
// — raced on two shared resources and silently dropped agents:
//   1. tmux session creation: N processes all see `mu-scratch` absent
//      and all run `new-session`; losers throw + rollback their row.
//   2. schema init: N processes opening the same fresh DB interleave the
//      non-transactional `DROP VIEW goals; CREATE VIEW goals` DDL and
//      hit 'view goals already exists'.
//
// The fix: a per-session advisory lock (src/agents/spawn-lock.ts) around
// the tmux topology + row finalize, plus busy_timeout + an atomic
// IMMEDIATE transaction around the schema DDL (src/db.ts).
//
// This MUST be a real-subprocess test — the in-process `runCli` helper
// can't reproduce a cross-process race. It shells out to the built
// `dist/cli.js`, so it requires `npm run build` first (CI builds before
// the full suite) and a real tmux server ($TMUX set).

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killSession } from "../src/tmux.js";

const execFileP = promisify(execFile);

const CLI = join(process.cwd(), "dist", "cli.js");
const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";
const BUILT = existsSync(CLI);
const describeIfReady = TMUX_AVAILABLE && BUILT ? describe : describe.skip;

describeIfReady("parallel spawn race (real cross-process)", () => {
  let tempDir: string;
  let dbPath: string;
  let workstream: string;
  let session: string;
  const N = 6;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-race-"));
    dbPath = join(tempDir, "mu.db");
    // Unique workstream per run so parallel suites never collide. Must
    // satisfy /^[a-z][a-z0-9_-]{0,31}$/ (no mu- prefix); keep it short.
    const rand = Math.floor(Math.random() * 1e6);
    workstream = `rt${process.pid}x${rand}`.slice(0, 32);
    session = `mu-${workstream}`;
  });

  afterEach(async () => {
    try {
      await killSession(session);
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  function spawnOne(name: string): Promise<void> {
    return execFileP("node", [CLI, "agent", "spawn", name, "-w", workstream, "--cli", "sh"], {
      env: {
        ...process.env,
        MU_DB_PATH: dbPath,
        // Skip the slow liveness/readiness waits: the sh panes are alive
        // and this test is about the topology/DB race, not startup.
        MU_SPAWN_LIVENESS_MS: "0",
        MU_SPAWN_READINESS_MS: "0",
      },
    }).then(() => undefined);
  }

  async function liveAgentCount(): Promise<number> {
    const { stdout } = await execFileP("node", [CLI, "agent", "list", "-w", workstream, "--json"], {
      env: { ...process.env, MU_DB_PATH: dbPath },
    });
    const parsed = JSON.parse(stdout) as { agents: unknown[] };
    return parsed.agents.length;
  }

  it(`all ${N} agents survive a simultaneous fan-out into one fresh workstream`, async () => {
    // Fire all N spawns concurrently — both the session-create race AND
    // the schema-init race trigger here (fresh DB + absent session).
    await Promise.all(Array.from({ length: N }, (_, i) => spawnOne(`scout-${i + 1}`)));
    expect(await liveAgentCount()).toBe(N);
  }, 30_000);

  it("all agents survive a fan-out into an EXISTING session (window-split race)", async () => {
    // Pre-create the session so the contended resource is window-split,
    // not session-create.
    await spawnOne("seed-0");
    await Promise.all(Array.from({ length: N }, (_, i) => spawnOne(`w-${i + 1}`)));
    expect(await liveAgentCount()).toBe(N + 1);
  }, 30_000);
});
