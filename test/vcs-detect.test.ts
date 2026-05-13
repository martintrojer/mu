// Tests for VcsBackend.detect + detectBackend precedence via each
// backend's canonical root command. Regression coverage for git
// worktrees: .git is a FILE there, so marker-dir heuristics miss them.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectBackend, gitBackend, jjBackend, noneBackend, slBackend } from "../src/vcs.js";
import { rmFixtureDir } from "./_fs.js";

let dirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmFixtureDir(d);
  dirs = [];
});

function has(bin: string): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

function git(repo: string, ...args: string[]): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "tester",
    GIT_AUTHOR_EMAIL: "tester@example.com",
    GIT_COMMITTER_NAME: "tester",
    GIT_COMMITTER_EMAIL: "tester@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  return execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
}

function initGitRepo(prefix = "mu-vcs-detect-git-"): string {
  const repo = tmp(prefix);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const gitDescribe = has("git") ? describe : describe.skip;
const jjDescribe = has("jj") ? describe : describe.skip;
const slDescribe = has("sl") ? describe : describe.skip;

gitDescribe("VCS detection — git", () => {
  it("detects a plain git repo and rejects jj/sl", async () => {
    const repo = initGitRepo();
    expect(await gitBackend.detect(repo)).toBe(true);
    expect(await jjBackend.detect(repo)).toBe(false);
    expect(await slBackend.detect(repo)).toBe(false);
    expect((await detectBackend(repo)).name).toBe("git");
  });

  it("detects a git worktree where .git is a gitdir pointer file", async () => {
    const repo = initGitRepo("mu-vcs-detect-git-main-");
    const worktree = tmp("mu-vcs-detect-git-worktree-");
    rmFixtureDir(worktree);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree, "-b", "worker"], {
      stdio: "ignore",
    });

    expect(await gitBackend.detect(worktree)).toBe(true);
    expect((await detectBackend(worktree)).name).toBe("git");
  });
});

jjDescribe("VCS detection — jj", () => {
  it("detects a plain jj repo", async () => {
    const repo = tmp("mu-vcs-detect-jj-");
    execFileSync("jj", ["git", "init", "--no-colocate", repo], { stdio: "ignore" });

    expect(await jjBackend.detect(repo)).toBe(true);
    expect(await slBackend.detect(repo)).toBe(false);
    expect(await gitBackend.detect(repo)).toBe(false);
  });

  it("detectBackend returns jj for a jj-colocated-on-git repo", async () => {
    const repo = tmp("mu-vcs-detect-jj-colocated-");
    execFileSync("jj", ["git", "init", "--colocate", repo], { stdio: "ignore" });

    expect(await jjBackend.detect(repo)).toBe(true);
    expect(await gitBackend.detect(repo)).toBe(true);
    expect((await detectBackend(repo)).name).toBe("jj");
  });
});

slDescribe("VCS detection — sl", () => {
  it("detects a plain sl repo", async () => {
    const repo = tmp("mu-vcs-detect-sl-");
    execFileSync("sl", ["init", "--git", repo], { stdio: "ignore" });

    expect(await slBackend.detect(repo)).toBe(true);
    expect(await jjBackend.detect(repo)).toBe(false);
    expect(await gitBackend.detect(repo)).toBe(false);
    expect((await detectBackend(repo)).name).toBe("sl");
  });

  it("detects a mercurial-compat .hg repo via sl root", async () => {
    const repo = tmp("mu-vcs-detect-hg-");
    execFileSync("sl", ["init", repo], { stdio: "ignore" });

    expect(await slBackend.detect(repo)).toBe(true);
    expect((await detectBackend(repo)).name).toBe("sl");
  });
});

describe("VCS detection — empty directory", () => {
  it("falls through to none", async () => {
    const dir = tmp("mu-vcs-detect-empty-");
    expect(await jjBackend.detect(dir)).toBe(false);
    expect(await slBackend.detect(dir)).toBe(false);
    expect(await gitBackend.detect(dir)).toBe(false);
    expect(await noneBackend.detect(dir)).toBe(true);
    expect((await detectBackend(dir)).name).toBe("none");
  });
});
