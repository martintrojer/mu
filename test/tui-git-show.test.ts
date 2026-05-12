// Functional test for src/cli/tui/git-show.ts (per
// review_tests_workspaces_show_loadshow_unmocked).
//
// The previous coverage was a static-source grep of workspaces.tsx
// for the literal "--color=never" / "SHOW_MAX_CHARS = 100_000" /
// "truncated at" strings. A regression that swapped --color=never
// for --color=always (would inject ANSI into the popup body) or
// silently lowered maxBuffer would have passed.
//
// Here we drive runGitShow against a real tiny git repo built in a
// mkdtemp dir. Three assertions:
//   1. Truncation kicks in at SHOW_MAX_CHARS (drive a large diff).
//   2. ANSI absent in stdout (--color=never honoured) — exercise via
//      a stub execFile that asserts the arg vector.
//   3. Bad sha returns a structured error (not a throw) with a
//      useful message.
// Plus arg-vector pinning via gitShowArgs(): cheap regression guard
// for `--color=always` swaps.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExecFileFn,
  SHOW_MAX_CHARS,
  gitShowArgs,
  runGitShow,
} from "../src/cli/tui/git-show.js";

// ─── arg vector (cheap regression guard) ─────────────────────────

describe("gitShowArgs", () => {
  it("pins the exact arg vector (catches --color=always swaps)", () => {
    expect(gitShowArgs("/tmp/repo", "abc123")).toEqual([
      "-C",
      "/tmp/repo",
      "show",
      "abc123",
      "--stat",
      "-p",
      "--color=never",
    ]);
  });

  it("--color=never is non-negotiable (no ANSI in popup body)", () => {
    const args = gitShowArgs("/tmp/repo", "deadbeef");
    expect(args).toContain("--color=never");
    expect(args).not.toContain("--color=always");
    expect(args).not.toContain("--color");
  });

  it("--stat + -p both present (full diff with summary)", () => {
    const args = gitShowArgs("/tmp/repo", "deadbeef");
    expect(args).toContain("--stat");
    expect(args).toContain("-p");
  });
});

// ─── functional: real tiny git repo ──────────────────────────────

describe("runGitShow against a real git repo", () => {
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

    // Large commit — sized to land between SHOW_MAX_CHARS (100_000)
    // and 2×SHOW_MAX_CHARS (the helper's maxBuffer = 200_000): we
    // want git show's stdout > 100_000 so truncation fires, but
    // < 200_000 so the underlying execFile doesn't trip Node's
    // maxBuffer guard. Each line below is ~110 bytes (100 chars
    // payload + newline + `+` diff prefix); 1200 lines ≈ 132_000
    // bytes raw diff body, plus ~1KB of stat/header chrome.
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
    const r = await runGitShow(repoDir, smallSha);
    expect(r.error).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
    // --stat surfaces the file + churn line.
    expect(r.text).toContain("small.txt");
    // -p surfaces the actual added line.
    expect(r.text).toContain("+hello");
  });

  it("emits ZERO ANSI escape sequences (--color=never honoured)", async () => {
    if (!hasGit) return;
    const r = await runGitShow(repoDir, smallSha);
    expect(r.error).toBeNull();
    // ESC = 0x1B. Any presence means a regression to --color=always
    // (or removal of --color=never) silently injected colour codes
    // into the popup body. Build the pattern from a String.fromCharCode
    // to keep biome's no-control-characters-in-regex lint happy.
    const ansi = new RegExp(`${String.fromCharCode(0x1b)}\\[`);
    expect(r.text).not.toMatch(ansi);
  });

  it("truncates at SHOW_MAX_CHARS for a giant diff", async () => {
    if (!hasGit) return;
    const r = await runGitShow(repoDir, largeSha);
    expect(r.error).toBeNull();
    expect(r.truncated).toBe(true);
    // Truncated body is exactly SHOW_MAX_CHARS plus the trailing
    // "(truncated at N chars)" marker line.
    expect(r.text.length).toBeGreaterThan(SHOW_MAX_CHARS);
    expect(r.text).toContain(`truncated at ${SHOW_MAX_CHARS} chars`);
    // First SHOW_MAX_CHARS bytes should be the raw diff prefix.
    expect(r.text.slice(0, SHOW_MAX_CHARS)).toContain("large.txt");
  });

  it("returns a useful error string for a missing sha (does not throw)", async () => {
    if (!hasGit) return;
    const r = await runGitShow(repoDir, "0000000000000000000000000000000000000000");
    expect(r.error).not.toBeNull();
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
      const r = await runGitShow(nonRepo, "HEAD");
      expect(r.error).not.toBeNull();
      expect(r.text).toBe("");
      expect(r.error?.length).toBeGreaterThan(0);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ─── injection seam: stub execFile asserts the arg vector ────────

describe("runGitShow injects an execFile seam (no git required)", () => {
  it("passes the pinned arg vector + maxBuffer to the injected execFile", async () => {
    let captured: {
      file: string;
      args: readonly string[];
      options: { maxBuffer?: number };
    } | null = null;
    const stub: ExecFileFn = async (file, args, options) => {
      captured = { file, args, options };
      return { stdout: "ok\n", stderr: "" };
    };
    const r = await runGitShow("/tmp/repo", "deadbeef", { execFile: stub });
    expect(r.error).toBeNull();
    expect(r.text).toBe("ok\n");
    if (captured === null) throw new Error("stub execFile was never called");
    expect(captured.file).toBe("git");
    expect(captured.args).toEqual([
      "-C",
      "/tmp/repo",
      "show",
      "deadbeef",
      "--stat",
      "-p",
      "--color=never",
    ]);
    // maxBuffer must be at least 2× SHOW_MAX_CHARS so a near-cap
    // diff doesn't trip Node's default 1MB buffer error.
    expect(captured.options.maxBuffer).toBeGreaterThanOrEqual(SHOW_MAX_CHARS * 2);
  });

  it("converts injected throws into structured { error } (no re-throw)", async () => {
    const stub: ExecFileFn = async () => {
      throw new Error("simulated git failure");
    };
    const r = await runGitShow("/tmp/repo", "deadbeef", { execFile: stub });
    expect(r.error).toBe("simulated git failure");
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
  });

  it("truncates injected stdout at SHOW_MAX_CHARS", async () => {
    const huge = "x".repeat(SHOW_MAX_CHARS + 500);
    const stub: ExecFileFn = async () => ({ stdout: huge, stderr: "" });
    const r = await runGitShow("/tmp/repo", "deadbeef", { execFile: stub });
    expect(r.error).toBeNull();
    expect(r.truncated).toBe(true);
    expect(r.text).toContain(`truncated at ${SHOW_MAX_CHARS} chars`);
  });
});
