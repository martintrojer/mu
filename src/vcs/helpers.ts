// mu — shared helpers for concrete VCS backends.

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { type CommitSummary, SHOW_COMMIT_MAX_CHARS, type ShowCommitResult } from "./types.js";

export const exec = promisify(execFile);

export async function probeVcsRootPath(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const stdout = await run(cmd, args, cwd);
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    // Tool not installed, or tool exited non-zero because cwd is not
    // in that backend's repo type. Both mean "not this backend".
    return null;
  }
}

export async function probeVcsRoot(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return (await probeVcsRootPath(cmd, args, cwd)) !== null;
}

export function isSaplingDotdir(dotdir: string): boolean {
  return /(?:^|[\\/])\.(?:sl|hg)$/.test(dotdir);
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function rmDirSync(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/**
 * Run a binary with args. Throws a typed Error on non-zero exit. Stdout
 * is returned trimmed; stderr is appended to the Error message.
 */
export async function run(bin: string, args: readonly string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec(bin, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`vcs ${bin} ${args.join(" ")} failed: ${msg}`);
  }
}

export async function runShow(
  bin: string,
  args: readonly string[],
  cwd?: string,
): Promise<ShowCommitResult> {
  try {
    const { stdout } = await exec(bin, [...args], {
      cwd,
      maxBuffer: SHOW_COMMIT_MAX_CHARS * 2,
    });
    if (stdout.length > SHOW_COMMIT_MAX_CHARS) {
      return {
        text: `${stdout.slice(0, SHOW_COMMIT_MAX_CHARS)}\n…(truncated at ${SHOW_COMMIT_MAX_CHARS} chars)`,
        truncated: true,
      };
    }
    return { text: stdout, truncated: false };
  } catch (err) {
    return {
      text: "",
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function relTimeFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

export function commitSummary(
  sha: string,
  subject: string,
  body: string,
  authorDate: string,
  author = "",
): CommitSummary {
  return { sha, subject, body, author, authorDate, relTime: relTimeFromIso(authorDate) };
}

export function saneLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 25;
  return Math.max(0, Math.min(200, Math.floor(limit)));
}

/**
 * Parse the NUL-field / \x1e-record format used by the jj/sl
 * commitsSinceBase impls. Each record is `sha\0subject\0body\0date`
 * terminated by \x1e. Empty input → [].
 */
export function parseNulRecords(raw: string): CommitSummary[] {
  if (raw.length === 0) return [];
  const records: CommitSummary[] = [];
  for (const rec of raw.split("\x1e")) {
    if (rec.length === 0) continue;
    const fields = rec.split("\x00");
    const sha = fields[0] ?? "";
    if (sha.length === 0) continue;
    records.push(
      commitSummary(sha, fields[1] ?? "", fields[2] ?? "", fields[3] ?? "", fields[4] ?? ""),
    );
  }
  return records;
}
