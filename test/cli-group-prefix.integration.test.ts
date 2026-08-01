// bug_group_id_prefix_asymmetry — group ids resolve identically in
// `mu undo` and `mu log --group`.
//
// The bug was only visible ACROSS verbs: `mu undo` printed an 8-char
// prefix and accepted one, but `mu log --group <prefix>` compared the
// column literally and returned zero rows. Each verb was self-consistent,
// so neither R9 nor R10 could catch it alone.
//
// The failure was SILENT and misleading: an empty log reads as "this group
// did nothing", which could lead an operator to skip inspection or undo
// the wrong group. And `mu undo`'s own Next: hint printed the short form,
// so mu suggested a command that did not work.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;

interface UndoJson {
  groupId?: string;
  groups?: Array<{ groupId: string }>;
  nextSteps?: Array<{ intent: string; command: string }>;
}

interface LogJson {
  items: Array<{ seq: number; group: string; intent: string | null; rendered: string }>;
}

/** Strip SGR so assertions read prose, not escapes. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-groupprefix-"));
  dbPath = join(tempDir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "demo");
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("the three-step group workflow with a SHORT id", () => {
  // THE regression test: the exact workflow, end to end, using only the
  // abbreviated id mu itself printed.
  it("mu undo → mu log --group <short> → mu undo <short> --yes", async () => {
    const add = await runCli(
      ["task", "add", "t1", "-t", "Build it", "-i", "50", "-e", "1", "-w", "demo"],
      dbPath,
    );
    expect(add.exitCode).toBeNull();

    // STEP 1: `mu undo` with no args prints the short id.
    const listing = await runCli(["undo", "--json"], dbPath);
    expect(listing.exitCode).toBeNull();
    const parsed = JSON.parse(listing.stdout.trim()) as UndoJson;
    const fullId = parsed.groupId ?? parsed.groups?.[0]?.groupId;
    expect(fullId).toBeDefined();
    if (fullId === undefined) return;
    const shortId = fullId.slice(0, 8);
    expect(shortId.length).toBe(8);
    expect(shortId).not.toBe(fullId);

    // STEP 2: inspect it. This is the step that silently returned nothing.
    const inspect = await runCli(["log", "--group", shortId, "-w", "demo"], dbPath);
    expect(inspect.exitCode).toBeNull();
    expect(plain(inspect.stdout)).toContain("task add t1");
    expect(plain(inspect.stdout)).not.toContain("(no log entries)");

    // STEP 3: commit the undo with the same short id.
    const undo = await runCli(["undo", shortId, "--yes"], dbPath);
    expect(undo.exitCode).toBeNull();

    // And the task really is gone.
    const show = await runCli(["task", "show", "t1", "-w", "demo"], dbPath);
    expect(show.exitCode).not.toBeNull();
  });

  it("the short and full forms of --group return identical rows", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    const listing = await runCli(["undo", "--json"], dbPath);
    const parsed = JSON.parse(listing.stdout.trim()) as UndoJson;
    const fullId = parsed.groupId ?? parsed.groups?.[0]?.groupId;
    if (fullId === undefined) throw new Error("no group id");

    const byShort = await runCli(
      ["log", "--group", fullId.slice(0, 8), "-w", "demo", "--json"],
      dbPath,
    );
    const byFull = await runCli(["log", "--group", fullId, "-w", "demo", "--json"], dbPath);
    const shortItems = (JSON.parse(byShort.stdout.trim()) as LogJson).items;
    const fullItems = (JSON.parse(byFull.stdout.trim()) as LogJson).items;
    expect(shortItems.length).toBeGreaterThan(0);
    expect(shortItems.map((i) => i.seq)).toEqual(fullItems.map((i) => i.seq));
  });

  // mu must not suggest a command that does not work.
  it("every group id in undo's Next: hints is accepted by mu log --group", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    const listing = await runCli(["undo", "--json"], dbPath);
    const parsed = JSON.parse(listing.stdout.trim()) as UndoJson;
    const hints = (parsed.nextSteps ?? []).map((s) => s.command);
    // Pull any concrete id out of the hint commands (skip <placeholders>).
    const ids = hints
      .flatMap((c) => c.split(/\s+/))
      .filter((tok) => /^[0-9a-f]{8}(-[0-9a-f-]+)?$/.test(tok));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const r = await runCli(["log", "--group", id, "-w", "demo", "--json"], dbPath);
      expect(r.exitCode, `mu log --group ${id} must work`).toBeNull();
      const items = (JSON.parse(r.stdout.trim()) as LogJson).items;
      expect(items.length, `group ${id} should have ops`).toBeGreaterThan(0);
    }
  });
});

describe("group prefix resolution errors", () => {
  // Previously an unmatched prefix degraded to an empty listing, which is
  // indistinguishable from "that group did nothing".
  it("an unmatched prefix is exit 3, not an empty listing", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    const r = await runCli(["log", "--group", "deadbeef", "-w", "demo"], dbPath);
    expect(r.exitCode).toBe(3);
    expect(plain(r.stderr)).toContain("deadbeef");
    expect(plain(r.stdout)).not.toContain("(no log entries)");
  });

  it("an ambiguous prefix is exit 4 in BOTH verbs, naming the candidates", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    // Force a collision: two groups sharing the first 8 chars.
    const db = openDb({ path: dbPath });
    try {
      db.prepare("UPDATE ops SET group_id = ? WHERE seq = 1").run(
        "aaaaaaaa-1111-1111-1111-111111111111",
      );
      db.prepare("UPDATE ops SET group_id = ? WHERE seq = 2").run(
        "aaaaaaaa-2222-2222-2222-222222222222",
      );
    } finally {
      db.close();
    }

    for (const argv of [
      ["log", "--group", "aaaaaaaa", "-w", "demo"],
      ["undo", "aaaaaaaa"],
    ]) {
      const r = await runCli(argv, dbPath);
      expect(r.exitCode, argv.join(" ")).toBe(4);
      expect(plain(r.stderr)).toContain("ambiguous");
      expect(plain(r.stderr)).toContain("aaaaaaaa-111");
    }
  });

  it("a full id still wins over prefix matching", async () => {
    await runCli(["task", "add", "t1", "-t", "T", "-i", "5", "-e", "1", "-w", "demo"], dbPath);
    const db = openDb({ path: dbPath });
    let full = "";
    try {
      // One id that is a strict prefix of another: the exact match must win
      // rather than being reported ambiguous.
      db.prepare("UPDATE ops SET group_id = 'abc' WHERE seq = 1").run();
      db.prepare("UPDATE ops SET group_id = 'abcdef' WHERE seq = 2").run();
      full = "abc";
    } finally {
      db.close();
    }
    const r = await runCli(["log", "--group", full, "-w", "demo", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const items = (JSON.parse(r.stdout.trim()) as LogJson).items;
    expect(items.every((i) => i.group === "abc")).toBe(true);
  });
});
