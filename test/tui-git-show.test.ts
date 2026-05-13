// Functional test for coloured VcsBackend.showCommit output used by
// the TUI git-show drills.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHOW_COMMIT_MAX_CHARS, gitBackend } from "../src/vcs.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[`);

describe("gitBackend.showCommit against a real git repo", () => {
  let repoDir: string;
  let smallSha: string;
  let largeSha: string;
  let hasGit = false;

  beforeAll(() => {
    // Skip the whole describe gracefully if git isn't on PATH.
    const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
    hasGit = probe.status === 0;
    if (!hasGit) return;

    repoDir = mkdtempSync(join(tmpdir(), "mu-tui-git-show-"));
    const env = {
      ...process.env,
      // Deterministic + isolated from the user's git config.
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repoDir, ...args], { env, stdio: "pipe" });

    git("init", "-q", "-b", "main");

    // Small commit — used for the success / no-truncation assertion.
    writeFileSync(join(repoDir, "small.txt"), "hello\n");
    git("add", "small.txt");
    git("commit", "-q", "-m", "small commit");
    smallSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      env,
      encoding: "utf-8",
    }).trim();

    // Large commit — sized to land between SHOW_COMMIT_MAX_CHARS (100_000)
    // and 2×SHOW_COMMIT_MAX_CHARS (the backend's maxBuffer = 200_000): we
    // want git show's stdout > 100_000 so truncation fires, but
    // < 200_000 so the underlying exec doesn't trip its maxBuffer
    // guard. Each line below is ~110 bytes (100 chars payload +
    // newline + `+` diff prefix); 1200 lines ≈ 132_000 bytes raw
    // diff body, plus ~1KB of stat/header chrome.
    const big = Array.from({ length: 1200 }, (_, i) => `${`line-${i}-`.padEnd(100, "x")}`).join(
      "\n",
    );
    writeFileSync(join(repoDir, "large.txt"), `${big}\n`);
    git("add", "large.txt");
    git("commit", "-q", "-m", "large commit");
    largeSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      env,
      encoding: "utf-8",
    }).trim();
  }, 30_000);

  afterAll(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  it("captures diff for a small commit (no truncation, no error)", async () => {
    if (!hasGit) return;
    const r = await gitBackend.showCommit(repoDir, smallSha);
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
    // --stat surfaces the file + churn line.
    expect(r.text).toContain("small.txt");
    // -p surfaces the actual added line (with ANSI colour interleaved).
    expect(stripAnsi(r.text)).toContain("+hello");
  });

  it("preserves ANSI escape sequences from the shared VcsBackend.showCommit seam", async () => {
    if (!hasGit) return;
    const r = await gitBackend.showCommit(repoDir, smallSha);
    expect(r.error).toBeUndefined();
    expect(r.text).toMatch(ANSI_RE);
  });

  it("truncates at SHOW_COMMIT_MAX_CHARS for a giant diff", async () => {
    if (!hasGit) return;
    const r = await gitBackend.showCommit(repoDir, largeSha);
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(true);
    // Truncated body is exactly SHOW_COMMIT_MAX_CHARS plus the trailing
    // "(truncated at N chars)" marker line.
    expect(r.text.length).toBeGreaterThan(SHOW_COMMIT_MAX_CHARS);
    expect(r.text).toContain(`truncated at ${SHOW_COMMIT_MAX_CHARS} chars`);
    // First SHOW_COMMIT_MAX_CHARS bytes should be the raw diff prefix.
    expect(r.text.slice(0, SHOW_COMMIT_MAX_CHARS)).toContain("large.txt");
  });

  it("returns a useful error string for a missing sha (does not throw)", async () => {
    if (!hasGit) return;
    const r = await gitBackend.showCommit(repoDir, "0000000000000000000000000000000000000000");
    expect(r.error).toBeDefined();
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
    // Whatever git's wording is, it should mention the bad sha or
    // be a non-trivial message — guard against the "" / "{}" stringify
    // regression.
    expect(r.error?.length).toBeGreaterThan(0);
  });

  it("returns a useful error string for a non-repo path (does not throw)", async () => {
    if (!hasGit) return;
    const nonRepo = mkdtempSync(join(tmpdir(), "mu-tui-git-show-empty-"));
    try {
      const r = await gitBackend.showCommit(nonRepo, "HEAD");
      expect(r.error).toBeDefined();
      expect(r.text).toBe("");
      expect(r.error?.length).toBeGreaterThan(0);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(0x1b);
  return text.replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}
