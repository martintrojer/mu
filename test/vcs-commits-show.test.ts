// Tests for VcsBackend.recentCommits + showCommit (git/jj/sl/none).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitBackend, jjBackend, noneBackend, slBackend } from "../src/vcs.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[`);

let dirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function has(bin: string): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

const gitDescribe = has("git") ? describe : describe.skip;
const jjDescribe = has("jj") ? describe : describe.skip;
const slDescribe = has("sl") ? describe : describe.skip;

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

gitDescribe("gitBackend recentCommits + showCommit", () => {
  it("lists newest-first commits and shows a diff", async () => {
    const repo = tmp("mu-vcs-git-commits-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first commit");
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "second commit", "-m", "body line");
    const second = git(repo, "rev-parse", "HEAD");

    const commits = await gitBackend.recentCommits(repo, 2);
    expect(commits.map((c) => c.sha)).toEqual([second, first]);
    expect(commits[0]?.subject).toBe("second commit");
    expect(commits[0]?.body).toContain("body line");
    expect(commits[0]?.author).toBe("tester");
    expect(commits[0]?.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(commits[0]?.relTime).toMatch(/^\d+[smhdw]$/);

    const shown = await gitBackend.showCommit(repo, second);
    expect(shown.error).toBeUndefined();
    expect(shown.truncated).toBe(false);
    expect(shown.text).toContain("second commit");
    expect(shown.text).toContain("b.txt");
    expect(shown.text).toMatch(ANSI_RE);
  });
});

jjDescribe("jjBackend recentCommits + showCommit", () => {
  it("lists commits and shows a change", async () => {
    const repo = tmp("mu-vcs-jj-commits-");
    execFileSync("jj", ["git", "init", repo], { stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "a\n");
    execFileSync("jj", ["describe", "-m", "jj first"], { cwd: repo, stdio: "ignore" });
    const first = execFileSync(
      "jj",
      ["log", "-r", "@", "--no-graph", "--no-pager", "--color", "never", "--template", "commit_id"],
      { cwd: repo, encoding: "utf8" },
    ).trim();
    execFileSync("jj", ["new"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "b.txt"), "b\n");
    execFileSync("jj", ["describe", "-m", "jj second", "-m", "jj body"], {
      cwd: repo,
      stdio: "ignore",
    });

    const commits = await jjBackend.recentCommits(repo, 5);
    expect(commits.some((c) => c.sha === first || c.subject === "jj first")).toBe(true);
    expect(commits[0]?.subject).toContain("jj second");
    expect(commits[0]?.body).toContain("jj body");
    expect(commits[0]?.relTime).toMatch(/^\d+[smhdw]$/);

    const shown = await jjBackend.showCommit(repo, commits[0]?.sha ?? "@");
    expect(shown.error).toBeUndefined();
    expect(shown.text).toContain("jj second");
    expect(shown.text).toMatch(ANSI_RE);
  });
});

slDescribe("slBackend recentCommits + showCommit", () => {
  it("lists commits and shows a commit", async () => {
    const repo = tmp("mu-vcs-sl-commits-");
    execFileSync("sl", ["init", repo], { stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "a\n");
    execFileSync("sl", ["--config", "ui.username=tester <t@t>", "commit", "-A", "-m", "sl first"], {
      cwd: repo,
      stdio: "ignore",
    });
    const first = execFileSync("sl", ["log", "-r", ".", "--template", "{node}"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(repo, "b.txt"), "b\n");
    execFileSync(
      "sl",
      ["--config", "ui.username=tester <t@t>", "commit", "-A", "-m", "sl second"],
      {
        cwd: repo,
        stdio: "ignore",
      },
    );
    const second = execFileSync("sl", ["log", "-r", ".", "--template", "{node}"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    const commits = await slBackend.recentCommits(repo, 2);
    expect(commits.map((c) => c.sha)).toEqual([second, first]);
    expect(commits[0]?.subject).toBe("sl second");
    expect(commits[0]?.author.length).toBeGreaterThan(0);
    expect(commits[0]?.relTime).toMatch(/^\d+[smhdw]$/);

    const shown = await slBackend.showCommit(repo, second);
    expect(shown.error).toBeUndefined();
    expect(shown.text).toContain("sl second");
    expect(shown.text).toMatch(ANSI_RE);
  });
});

describe("noneBackend recentCommits + showCommit", () => {
  it("returns empty commits and graceful show error", async () => {
    const repo = tmp("mu-vcs-none-commits-");
    expect(await noneBackend.recentCommits(repo, 10)).toEqual([]);
    const shown = await noneBackend.showCommit(repo, "abc");
    expect(shown.text).toBe("");
    expect(shown.truncated).toBe(false);
    expect(shown.error).toContain("vcs none");
  });
});
