// Stderr lint hint when `mu agent spawn <name>` is given a name that
// doesn't match the smallest-unused-suffix convention (`<role>-<n>`).
//
// Source: feedback ws task fb_agent_naming_convention. Reporter dogfood
// trace: today named agents reviewer-1/2/3, worker-1/2/3, then
// `worker-tests` because the task was tests — broke the numbered-suffix
// convention. mu accepted the spawn silently. The fix mirrors the
// slugify-truncation hint in cmdTaskAdd (commit 28a13af): a one-line
// stderr hint, exit 0, suppressed under --json. The spawn itself still
// succeeds — this is a lint, not a rule.
//
// Coverage:
//   1. conforming name (`worker-1`)         — no hint, spawn succeeds
//   2. non-conforming name (`worker-tests`) — hint to stderr, spawn succeeds
//   3. additional shapes operators reach for (`alice`, `db-leader`,
//      `x-y-1`) — all warn, since none match `<role>-<n>`
//   4. --json mode (process.argv carries --json) — suppresses the hint
//      regardless of name shape

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { type MockState, freshMockState, mockTmux } from "./_verbs-mock.js";

// ─── stderr capture helper ─────────────────────────────────────────────

interface StderrCapture {
  stderr: string;
  restore: () => void;
}

function captureStderr(): StderrCapture {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  // biome-ignore lint/suspicious/noExplicitAny: shim signature matches what we need
  (process.stderr as any).write = (chunk: any) => {
    stderr += String(chunk);
    return true;
  };
  return {
    get stderr() {
      return stderr;
    },
    restore: () => {
      process.stderr.write = original;
    },
  };
}

// Mutate process.argv for the duration of `fn` so isJsonMode() (which
// scans process.argv directly) sees --json without the test reaching
// into the CLI plumbing. Mirrors the technique used by runCli's
// argv shim (see test/_runCli.ts) but at unit-test scale.
async function withArgv(argv: readonly string[], fn: () => Promise<void>): Promise<void> {
  const original = process.argv;
  process.argv = ["node", "mu", ...argv];
  try {
    await fn();
  } finally {
    process.argv = original;
  }
}

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;
let state: MockState;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-spawn-name-hint-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  state = freshMockState();
  resetTmuxExecutor();
  setSleepForTests(async () => {});
  // Skip the post-spawn liveness sleep — the mock pane stays alive
  // forever so the check would just waste 1500ms per test. Matches the
  // pattern in test/verbs-spawn.test.ts.
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  const { executor } = mockTmux(state);
  setTmuxExecutor(executor);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe("spawnAgent — non-conventional name stderr hint", () => {
  it("emits no hint for a conforming <role>-<n> name", async () => {
    const cap = captureStderr();
    try {
      const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
      expect(agent.name).toBe("worker-1");
    } finally {
      cap.restore();
    }
    expect(cap.stderr).toBe("");
  });

  it("also accepts multi-digit suffixes (scout-12) silently", async () => {
    const cap = captureStderr();
    try {
      await spawnAgent(db, { name: "scout-12", workstream: "auth" });
    } finally {
      cap.restore();
    }
    expect(cap.stderr).toBe("");
  });

  it("emits a one-line stderr hint when the name violates the convention", async () => {
    const cap = captureStderr();
    let agentName: string | undefined;
    try {
      const agent = await spawnAgent(db, { name: "worker-tests", workstream: "auth" });
      agentName = agent.name;
    } finally {
      cap.restore();
    }
    // Spawn still succeeded — this is a lint, not an error.
    expect(agentName).toBe("worker-tests");
    // Hint reaches stderr, names the offending name, points at the
    // <role>-<n> shape, and gives concrete examples.
    expect(cap.stderr).toContain("hint:");
    expect(cap.stderr).toContain("worker-tests");
    expect(cap.stderr).toContain("<role>-<n>");
    expect(cap.stderr).toContain("worker-1");
    // Exactly one line (trailing newline only, no extra noise).
    const lines = cap.stderr.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it.each([["alice"], ["db-leader"], ["x-y-1"]])(
    "warns on shape %j (no `-<n>` suffix or extra hyphens)",
    async (name) => {
      const cap = captureStderr();
      try {
        await spawnAgent(db, { name, workstream: "auth" });
      } finally {
        cap.restore();
      }
      expect(cap.stderr).toContain("hint:");
      expect(cap.stderr).toContain(name);
    },
  );

  it("suppresses the hint under --json mode", async () => {
    const cap = captureStderr();
    try {
      await withArgv(["agent", "spawn", "worker-tests", "--json"], async () => {
        const agent = await spawnAgent(db, { name: "worker-tests", workstream: "auth" });
        expect(agent.name).toBe("worker-tests");
      });
    } finally {
      cap.restore();
    }
    // No stderr noise — machine consumers stay clean.
    expect(cap.stderr).toBe("");
  });
});
