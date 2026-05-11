// Locks in the cli-table3 column-header rename from
// `output_labels_human_rename` (Phase 2 of OUTPUT_LABELS_AUDIT).
//
// Convention (per docs/OUTPUT_LABELS_AUDIT.md):
//   - `mu task list / next / owned-by` table header `id` → `name`.
//     (`task blocked / goals / search` were removed in
//     audit_cleanups_post_schema_v5_wave; `task ready` was merged
//     into `task next -n 0` in the same wave; `my-tasks` / `my-next`
//     became `mu me tasks` / `mu me next`. The SQL escape hatches
//     for the removed verbs live in docs/USAGE_GUIDE.md.)
//
// JSON shape is intentionally NOT touched here (the JSON rename is
// `output_json_keys_rename_v5`, a separate breaking commit). Tests
// elsewhere assert the `--json` shape still uses `localId` / `slug`
// / `workstream`.
//
// Each assertion strips ANSI (the headers are pc.bold(...)-wrapped)
// before substring-matching, so the tests don't depend on whether
// picocolors is in colour mode.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addBlockEdge, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

describe("output_labels_human_rename: cli-table3 column headers", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-labels-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    // 'a' is ready (no edges). 'b' depends on 'a' (so 'b' is blocked).
    // 'c' is a standalone goal-shaped task (no parents, so qualifies
    // as a goal). All three together cover list/next/ready/blocked/goals.
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
    addBlockEdge(db, "auth", "b", "a");
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── task-side verbs: header `id` → `name` ─────────────────────

  it("`mu task list` renders a `name` column header (not `id`)", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth"], dbPath);
    const visible = stripAnsi(stdout);
    expect(visible).toContain("name");
    // The bare word `id` must not appear as a header. Frame the match
    // between │ borders or whitespace so we don't false-positive on a
    // title or workstream slug containing 'id'.
    expect(visible).not.toMatch(/[│\s]id[│\s]/);
  });

  it("`mu task next -n 0` (merged-in `task ready`) renders a `name` column header (not `id`)", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "0"], dbPath);
    const visible = stripAnsi(stdout);
    expect(visible).toContain("name");
    expect(visible).not.toMatch(/[│\s]id[│\s]/);
  });

  it("`mu task next` renders a `name` column header (not `id`)", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth"], dbPath);
    const visible = stripAnsi(stdout);
    expect(visible).toContain("name");
    expect(visible).not.toMatch(/[│\s]id[│\s]/);
  });

  // ── --json shape preserved (this task is human-only) ──────────

  // POST output_json_keys_rename_v5: --json emits the v5 `name` key.
  // The human-rename task left the JSON shape alone; the v5 rename
  // (this task) flipped it. Both column header AND JSON now agree.
  //
  // POST drop_taskrow_localid_duplicate_of_name: the `localId`
  // duplicate field was dropped (sole user; codebase reads `.name`
  // canonically). `name` is once again the only id key on a task.
  it("`mu task list --json` emits `name` as the sole per-workstream id key", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--json"], dbPath);
    const env = JSON.parse(stdout.trim()) as {
      items: Array<Record<string, unknown>>;
      count: number;
    };
    expect(env.items.length).toBeGreaterThan(0);
    expect(env.count).toBe(env.items.length);
    const first = env.items[0];
    if (!first) throw new Error("expected at least one task row");
    expect(first).toHaveProperty("name");
    expect(first).not.toHaveProperty("localId");
  });
});
