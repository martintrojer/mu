// Tests for the staleness column + warn line surfaced by
// bug_workspace_stale_parent_silent_drift.
//
// `mu workspace list` and `mu state` both decorate workspace rows
// with `commitsBehindMain` and render it as a color-coded "behind"
// column. When ANY workspace is >=10 behind, `mu state` appends a
// one-line warning under the Workspaces section.
//
// Tests drive the CLI in-process via the shared runCli helper.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let stateRoot: string;
let dbDir: string;
let dbPath: string;
let db: Db;
let originDir: string;
let consumerProject: string;

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitDescribe = GIT ? describe : describe.skip;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "mu-stale-state-"));
  process.env.MU_STATE_DIR = stateRoot;
  dbDir = mkdtempSync(join(tmpdir(), "mu-stale-db-"));
  dbPath = join(dbDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  db.close();
});

afterEach(() => {
  for (const dir of [stateRoot, dbDir, originDir, consumerProject]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

gitDescribe("workspace staleness rendering", () => {
  // Helper: set up a bare origin + a consumer clone, and create the
  // workspace via the CLI (which detects the git backend and records
  // parent_ref). Optionally advance origin by N commits and fetch into
  // the workspace so origin/main moves while parent_ref stays put.
  async function setupWithStaleness(commitsAhead: number): Promise<string> {
    const projectRoot = mkdtempSync(join(tmpdir(), "mu-stale-project-"));
    writeFileSync(join(projectRoot, "a.txt"), "a\n");
    execFileSync("git", ["init", "-q", "-b", "main", projectRoot], { stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: projectRoot,
    });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c1"], {
      cwd: projectRoot,
    });
    originDir = mkdtempSync(join(tmpdir(), "mu-stale-origin-"));
    rmSync(originDir, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", "--bare", projectRoot, originDir], { stdio: "ignore" });
    rmSync(projectRoot, { recursive: true, force: true });
    consumerProject = mkdtempSync(join(tmpdir(), "mu-stale-consumer-"));
    rmSync(consumerProject, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", originDir, consumerProject], { stdio: "ignore" });
    // Create the workspace via the CLI so it records the row + parent_ref.
    const create = await runCli(
      [
        "workspace",
        "create",
        "worker-1",
        "-w",
        "auth",
        "--backend",
        "git",
        "--project-root",
        consumerProject,
      ],
      dbPath,
    );
    expect(create.error).toBeUndefined();
    expect(create.exitCode).not.toBe(1);
    // Advance origin by N commits and fetch into the workspace.
    if (commitsAhead > 0) {
      const advancer = mkdtempSync(join(tmpdir(), "mu-stale-advance-"));
      rmSync(advancer, { recursive: true, force: true });
      execFileSync("git", ["clone", "-q", originDir, advancer], { stdio: "ignore" });
      for (let i = 0; i < commitsAhead; i++) {
        writeFileSync(join(advancer, `f${i}.txt`), `${i}\n`);
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
          cwd: advancer,
        });
        execFileSync(
          "git",
          ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `c${i + 2}`],
          { cwd: advancer },
        );
      }
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: advancer });
      rmSync(advancer, { recursive: true, force: true });
      // Operator-side fetch (mu itself never fetches).
      const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: wsPath });
    }
    return consumerProject;
  }

  it("workspace list --json includes commitsBehindMain when behind=0", async () => {
    await setupWithStaleness(0);
    const r = await runCli(["workspace", "list", "-w", "auth", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    const rows = JSON.parse(r.stdout) as { commitsBehindMain: number | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitsBehindMain).toBe(0);
  });

  it("workspace list table renders a 'behind' column with a number", async () => {
    await setupWithStaleness(5);
    // Pin the underlying value structurally via --json so a regression
    // that drops commitsBehindMain (or always returns 0) fails here
    // even if the table happens to contain a coincidental "5" digit
    // (the row's created_at ISO date alone is enough to satisfy a
    // bare /\b5\b/ search — see
    // review_test_workspace_staleness_behind_value_unanchored).
    const j = await runCli(["workspace", "list", "-w", "auth", "--json"], dbPath);
    expect(j.error).toBeUndefined();
    const rows = JSON.parse(j.stdout) as { commitsBehindMain: number | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitsBehindMain).toBe(5);
    // Also assert the table surface: header word "behind" present,
    // and the value 5 appears in the behind column specifically (not
    // just anywhere in the row). cli-table3 separates columns with
    // " │ "; we anchor on that to avoid matching the parent_ref hash
    // or the created_at timestamp.
    const r = await runCli(["workspace", "list", "-w", "auth"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toMatch(/behind/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    // Column order: agent | workstream | backend | path | parent_ref | behind | created.
    // Match " │ 5 │ " for the behind cell — the column separator on
    // both sides anchors us inside that column, never matching the
    // 12-hex-char parent_ref or the ISO-date created_at.
    expect(plain).toMatch(/│ 5 +│ /);
  });

  it("mu state does NOT show the warn line when all workspaces are <10 behind", async () => {
    await setupWithStaleness(5);
    const r = await runCli(["state", "-w", "auth"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.stdout).not.toMatch(/stale .* commits behind/);
    expect(r.stdout).not.toMatch(/Tip: Free \+ recreate/);
  });

  it("mu state shows the warn line + tip when ANY workspace is >=10 behind", async () => {
    await setupWithStaleness(12);
    const r = await runCli(["state", "-w", "auth"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toMatch(/1 stale .*10 commits behind/);
    expect(r.stdout).toMatch(/Tip: Free \+ recreate stale workspaces/);
    expect(r.stdout).toMatch(/mu workspace free worker-1/);
    expect(r.stdout).toMatch(/mu workspace create worker-1/);
  });
});

describe("workspace staleness (none-backend)", () => {
  // The none-backend has no notion of main; the column should render
  // as "—" and no warning should ever fire.
  it("none-backend workspaces never trigger the warn line", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mu-stale-none-"));
    writeFileSync(join(projectRoot, "README"), "x\n");
    try {
      const create = await runCli(
        [
          "workspace",
          "create",
          "worker-1",
          "-w",
          "auth",
          "--backend",
          "none",
          "--project-root",
          projectRoot,
        ],
        dbPath,
      );
      expect(create.error).toBeUndefined();
      const r = await runCli(["state", "-w", "auth"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.stdout).not.toMatch(/stale .* commits behind/);
      // JSON must report null, not undefined or 0.
      const j = await runCli(["workspace", "list", "-w", "auth", "--json"], dbPath);
      const rows = JSON.parse(j.stdout) as { commitsBehindMain: number | null }[];
      expect(rows[0]?.commitsBehindMain).toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
