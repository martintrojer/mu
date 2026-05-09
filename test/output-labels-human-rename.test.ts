// Locks in the cli-table3 column-header rename from
// `output_labels_human_rename` (Phase 2 of OUTPUT_LABELS_AUDIT).
//
// Convention (per docs/OUTPUT_LABELS_AUDIT.md):
//   - `mu task list / next / ready / blocked / goals / owned-by /
//     search / my-tasks / my-next` table header `id` → `name`.
//   - `mu approve list` table header `slug` → `name`.
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
import { addApproval } from "../src/approvals.js";
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

  it("`mu task ready` renders a `name` column header (not `id`)", async () => {
    const { stdout } = await runCli(["task", "ready", "-w", "auth"], dbPath);
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

  it("`mu task blocked` renders a `name` column header (not `id`)", async () => {
    const { stdout } = await runCli(["task", "blocked", "-w", "auth"], dbPath);
    const visible = stripAnsi(stdout);
    expect(visible).toContain("name");
    expect(visible).not.toMatch(/[│\s]id[│\s]/);
  });

  it("`mu task goals` renders a `name` column header (not `id`)", async () => {
    const { stdout } = await runCli(["task", "goals", "-w", "auth"], dbPath);
    const visible = stripAnsi(stdout);
    expect(visible).toContain("name");
    expect(visible).not.toMatch(/[│\s]id[│\s]/);
  });

  // ── --json shape preserved (this task is human-only) ──────────

  it("`mu task list --json` still emits `localId` (JSON rename is a separate task)", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    const first = parsed[0];
    if (!first) throw new Error("expected at least one task row");
    expect(first).toHaveProperty("localId");
    expect(first).not.toHaveProperty("name");
  });
});

describe("output_labels_human_rename: approve list column header", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-labels-app-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    addApproval(db, {
      slug: "deploy-prod",
      workstream: "auth",
      reason: "ship the v5 cleanup",
      requestedBy: "alice",
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("`mu approve list` renders a `name` column header (not `slug`)", async () => {
    const { stdout } = await runCli(["approve", "list", "-w", "auth"], dbPath);
    const visible = stripAnsi(stdout);
    expect(visible).toContain("name");
    expect(visible).not.toMatch(/[│\s]slug[│\s]/);
  });

  it("`mu approve list --json` still emits `slug` (JSON rename is a separate task)", async () => {
    const { stdout } = await runCli(["approve", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    const first = parsed[0];
    if (!first) throw new Error("expected at least one approval row");
    expect(first).toHaveProperty("slug");
    expect(first).not.toHaveProperty("name");
  });
});
