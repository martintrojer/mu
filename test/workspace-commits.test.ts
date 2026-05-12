// Tests for `mu workspace commits` (fb_workspace_commits_verb /
// mu_workspace_commits_print_since_fork). Covers:
//
//   - The SDK seam (`listCommitsForWorkspace`) for the `none` backend
//     (always errors with WorkspaceVcsRequiredError) and the
//     missing-row case (WorkspaceNotFoundError).
//   - The git backend's `commitsSinceBase` happy path: returns the
//     workspace's draft commits oldest-first with sha, subject, body,
//     authorDate fields populated.
//   - The git backend's empty-result case: a workspace exactly at
//     parent_ref returns [].
//   - The git backend's preservation of multi-line subjects/bodies via
//     the NUL-delimited record format.
//   - The jj backend smoke test (skipped without jj on PATH).
//
// Mirrors the conditional-describe pattern in
// test/workspace-backends.test.ts.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { WorkspaceVcsRequiredError, gitBackend, jjBackend } from "../src/vcs.js";
import {
  WorkspaceNotFoundError,
  createWorkspace,
  listCommitsForWorkspace,
} from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let stateRoot: string;
let projectRoot: string;
let dbDir: string;
let db: Db;

function setStateDir(dir: string): void {
  process.env.MU_STATE_DIR = dir;
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "mu-commits-state-"));
  setStateDir(stateRoot);
  dbDir = mkdtempSync(join(tmpdir(), "mu-commits-db-"));
  db = openDb({ path: join(dbDir, "mu.db") });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  projectRoot = mkdtempSync(join(tmpdir(), "mu-commits-project-"));
  writeFileSync(join(projectRoot, "README"), "hello\n");
});

afterEach(() => {
  db.close();
  for (const dir of [stateRoot, dbDir, projectRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

// ─── SDK-level guards ─────────────────────────────────────────────────

describe("listCommitsForWorkspace (SDK)", () => {
  it("throws WorkspaceNotFoundError when no row for agent", async () => {
    let caught: unknown;
    try {
      await listCommitsForWorkspace(db, "ghost", { workstream: "auth" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("throws WorkspaceVcsRequiredError on the none backend", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    let caught: unknown;
    try {
      await listCommitsForWorkspace(db, "worker-1", { workstream: "auth" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceVcsRequiredError);
    expect((caught as Error).message).toContain("vcs none");
    expect((caught as Error).message).toContain("commits");
  });
});

// ─── git backend integration ──────────────────────────────────────────

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitDescribe = GIT ? describe : describe.skip;

function gitInit(): void {
  execFileSync("git", ["init", "-q", "-b", "main", projectRoot], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: projectRoot,
  });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
    cwd: projectRoot,
  });
}

gitDescribe("gitBackend.commitsSinceBase", () => {
  beforeEach(() => {
    gitInit();
  });

  it("returns [] when the workspace is exactly at parent_ref", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toBeTruthy();
    const commits = await gitBackend.commitsSinceBase(wsPath, r.parentRef ?? "");
    expect(commits).toEqual([]);
  });

  it("returns workspace draft commits oldest-first with sha/subject/body/authorDate", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    // Two commits in the workspace; the second has a body too.
    writeFileSync(join(wsPath, "a.txt"), "a\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: wsPath,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first commit"],
      { cwd: wsPath },
    );
    writeFileSync(join(wsPath, "b.txt"), "b\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: wsPath,
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "second commit",
        "-m",
        "longer body line\nspanning two lines",
      ],
      { cwd: wsPath },
    );
    const commits = await gitBackend.commitsSinceBase(wsPath, r.parentRef ?? "");
    expect(commits).toHaveLength(2);
    const first = commits[0];
    const second = commits[1];
    if (!first || !second) throw new Error("expected two commits");
    expect(first.subject).toBe("first commit");
    expect(second.subject).toBe("second commit");
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(second.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.sha).not.toBe(second.sha);
    // authorDate is ISO-8601 with timezone (e.g. 2026-05-10T12:34:56+00:00)
    expect(first.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The second commit's body should preserve the multi-line content.
    expect(second.body).toContain("longer body line");
    expect(second.body).toContain("spanning two lines");
  });

  it("preserves embedded newlines in subjects via the -z record format", async () => {
    // Edge case: git allows newlines in the message. The first
    // newline-separated segment is the subject, the rest body. Even
    // so, the -z record format means our parser doesn't get confused
    // by an embedded newline INSIDE the body field.
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    writeFileSync(join(wsPath, "x.txt"), "x\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: wsPath,
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "subject",
        "-m",
        "first body line\nsecond body line\nthird body line",
      ],
      { cwd: wsPath },
    );
    const commits = await gitBackend.commitsSinceBase(wsPath, r.parentRef ?? "");
    expect(commits).toHaveLength(1);
    const c = commits[0];
    if (!c) throw new Error("expected one commit");
    expect(c.subject).toBe("subject");
    expect(c.body).toContain("first body line");
    expect(c.body).toContain("third body line");
  });
});

// ─── SDK + git: end-to-end through listCommitsForWorkspace ─────────────

gitDescribe("listCommitsForWorkspace + git", () => {
  beforeEach(() => {
    gitInit();
  });

  it("dispatches via the workspace row's parent_ref by default", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "git",
    });
    expect(ws.parentRef).toBeTruthy();
    // Make a commit in the workspace.
    writeFileSync(join(ws.path, "z.txt"), "z\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: ws.path,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "draft"],
      { cwd: ws.path },
    );
    const r = await listCommitsForWorkspace(db, "worker-1", { workstream: "auth" });
    expect(r.vcs).toBe("git");
    expect(r.baseRef).toBe(ws.parentRef);
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0]?.subject).toBe("draft");
    expect(r.workspacePath).toBe(ws.path);
  });

  it("accepts --since override", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "git",
    });
    writeFileSync(join(ws.path, "z.txt"), "z\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: ws.path,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "draft"],
      { cwd: ws.path },
    );
    // --since HEAD should yield zero commits (HEAD..HEAD is empty).
    const r = await listCommitsForWorkspace(db, "worker-1", {
      workstream: "auth",
      since: "HEAD",
    });
    expect(r.baseRef).toBe("HEAD");
    expect(r.commits).toEqual([]);
  });

  it("CLI --json keeps commits in collection envelope and includes workspace metadata", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "git",
    });
    writeFileSync(join(ws.path, "z.txt"), "z\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: ws.path,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "draft"],
      { cwd: ws.path },
    );
    const { stdout, exitCode, error } = await runCli(
      ["workspace", "commits", "worker-1", "-w", "auth", "--json"],
      join(dbDir, "mu.db"),
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const env = JSON.parse(stdout.trim()) as {
      items: Array<{ subject: string }>;
      count: number;
      vcs: string;
      baseRef: string;
      workspacePath: string;
    };
    expect(env.count).toBe(1);
    expect(env.items[0]?.subject).toBe("draft");
    expect(env.vcs).toBe("git");
    expect(env.baseRef).toBe(ws.parentRef);
    expect(env.workspacePath).toBe(ws.path);
    expect(existsSync(env.workspacePath)).toBe(true);
  });
});

// ─── jj backend smoke (only runs when jj on PATH) ─────────────────────

const JJ = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const jjDescribe = JJ ? describe : describe.skip;

jjDescribe("jjBackend.commitsSinceBase (smoke)", () => {
  beforeEach(() => {
    execFileSync("jj", ["git", "init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("jj", ["commit", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
  });

  // Smoke: return shape is an array (possibly empty), and each
  // element has the four CommitSummary fields. We don't assert on
  // commit count because jj's working-copy semantics around `@`
  // differ subtly from git's HEAD and depend on jj version.
  it("returns an array of CommitSummary records (no throws)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const commits = await jjBackend.commitsSinceBase(wsPath, r.parentRef ?? "");
    expect(Array.isArray(commits)).toBe(true);
    for (const c of commits) {
      expect(typeof c.sha).toBe("string");
      expect(typeof c.subject).toBe("string");
      expect(typeof c.body).toBe("string");
      expect(typeof c.authorDate).toBe("string");
    }
  });
});
