// CLI-level tests for `mu task notes --tail / --since / --since-claim`.
//
// Surfaced by mufeedback note: `mu task notes <id>` dumps EVERY note
// (including multi-screen pre-task SPEC), so checking "what did the
// worker actually report at close?" requires scrolling. Three filters:
//
//   --tail N        : last N notes only
//   --since <iso>   : notes with created_at > <iso> only
//   --since-claim   : auto-resolves to the timestamp of the most
//                     recent `task claim` event in agent_logs
//
// Mutex: --since and --since-claim are mutually exclusive (both define
// a cutoff). --tail composes with either.
//
// JSON envelope: collection {items, count} per
// audit_json_envelope_uniformity.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask, claimTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

// Sleep helper: SQLite created_at is ISO with ms precision; rapid
// successive INSERTs can land in the same ms. The filter is `>`
// (strict), so we space inserts by ~5ms to keep timestamps strictly
// ordered without slowing the suite materially.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mu task notes — filters", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-notes-filters-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    addTask(db, {
      localId: "tnotes",
      workstream: "test",
      title: "Test notes filters",
      impact: 50,
      effortDays: 1,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Seed N notes at slightly different timestamps so the strict-`>`
  // cutoff in `listNotes` orders them deterministically.
  async function seedNotes(n: number, prefix = "note"): Promise<void> {
    for (let i = 0; i < n; i++) {
      addNote(db, "tnotes", `${prefix} ${i + 1}`, {
        author: "tester",
        workstream: "test",
      });
      await sleep(5);
    }
  }

  describe("--tail", () => {
    it("--tail 1 returns only the last note", async () => {
      await seedNotes(3);
      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--tail", "1", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      expect(r.exitCode === null || r.exitCode === 0).toBe(true);
      const out = JSON.parse(r.stdout) as {
        items: { content: string }[];
        count: number;
      };
      expect(out.count).toBe(1);
      expect(out.items).toHaveLength(1);
      expect(out.items[0]?.content).toBe("note 3");
    });

    it("--tail N where N >= total returns all notes", async () => {
      await seedNotes(3);
      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--tail", "99", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as { items: unknown[]; count: number };
      expect(out.count).toBe(3);
    });

    it("--last is an alias for --tail", async () => {
      await seedNotes(3);
      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--last", "2", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as {
        items: { content: string }[];
        count: number;
      };
      expect(out.count).toBe(2);
      expect(out.items.map((n) => n.content)).toEqual(["note 2", "note 3"]);
    });

    it("--tail 0 errors with usage (exit 2)", async () => {
      await seedNotes(2);
      const r = await runCli(["task", "notes", "tnotes", "-w", "test", "--tail", "0"], dbPath);
      expect(r.exitCode).toBe(2);
      // commander's parsePositiveNumber rejects 0 with InvalidArgumentError
      // → emitParseError surface ("error:" or similar). Just assert
      // SOMETHING explanatory hit stderr.
      expect(r.stderr.length).toBeGreaterThan(0);
    });

    it("--tail -1 errors with usage (exit 2)", async () => {
      await seedNotes(2);
      const r = await runCli(["task", "notes", "tnotes", "-w", "test", "--tail", "-1"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  });

  describe("--since", () => {
    it("--since <past iso> returns all notes", async () => {
      await seedNotes(3);
      // 1970-01-01 is before any seeded note.
      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--since", "1970-01-01T00:00:00.000Z", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as { items: unknown[]; count: number };
      expect(out.count).toBe(3);
    });

    it("--since <future iso> returns no notes", async () => {
      await seedNotes(3);
      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--since", "2999-01-01T00:00:00.000Z", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as { items: unknown[]; count: number };
      expect(out.count).toBe(0);
    });

    it("--since with unparseable value errors with usage (exit 2)", async () => {
      await seedNotes(1);
      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--since", "yesterday"],
        dbPath,
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/--since/);
    });
  });

  describe("--since-claim", () => {
    it("returns only post-claim notes", async () => {
      // Two notes BEFORE the claim (the pre-task SPEC scenario), then
      // claim, then two notes AFTER (the worker's progress).
      await seedNotes(2, "pre");
      // Register an agent for the worker-claim path (anonymous --self
      // would also work, but worker-claim mirrors the dispatch flow
      // the feedback note describes).
      insertAgent(db, {
        name: "worker-1",
        workstream: "test",
        paneId: "%999",
        status: "busy",
      });
      await claimTask(db, "tnotes", { workstream: "test", agentName: "worker-1" });
      await sleep(5);
      await seedNotes(2, "post");

      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--since-claim", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as {
        items: { content: string }[];
        count: number;
      };
      expect(out.count).toBe(2);
      expect(out.items.map((n) => n.content)).toEqual(["post 1", "post 2"]);
    });

    it("returns all notes when no claim event exists", async () => {
      await seedNotes(3);
      // No claim happened — `lastClaimEventAt` returns null, the SDK
      // degrades to no filter (equivalent to --since-beginning).
      const r = await runCli(
        ["task", "notes", "tnotes", "-w", "test", "--since-claim", "--json"],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as { items: unknown[]; count: number };
      expect(out.count).toBe(3);
    });
  });

  describe("mutex + envelope shape", () => {
    it("--since + --since-claim is a usage error (exit 2)", async () => {
      await seedNotes(1);
      const r = await runCli(
        [
          "task",
          "notes",
          "tnotes",
          "-w",
          "test",
          "--since",
          "1970-01-01T00:00:00.000Z",
          "--since-claim",
        ],
        dbPath,
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/mutually exclusive|--since-claim/);
    });

    it("--json emits the {items, count} collection envelope", async () => {
      await seedNotes(2);
      const r = await runCli(["task", "notes", "tnotes", "-w", "test", "--json"], dbPath);
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(out).toHaveProperty("items");
      expect(out).toHaveProperty("count");
      expect(Array.isArray(out.items)).toBe(true);
      expect(out.count).toBe(2);
    });

    it("default behaviour (no filters) is unchanged", async () => {
      await seedNotes(3);
      const r = await runCli(["task", "notes", "tnotes", "-w", "test", "--json"], dbPath);
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as {
        items: { content: string }[];
        count: number;
      };
      expect(out.count).toBe(3);
      expect(out.items.map((n) => n.content)).toEqual(["note 1", "note 2", "note 3"]);
    });

    it("--tail composes with --since (since first, then tail)", async () => {
      await seedNotes(5);
      const r = await runCli(
        [
          "task",
          "notes",
          "tnotes",
          "-w",
          "test",
          "--since",
          "1970-01-01T00:00:00.000Z",
          "--tail",
          "2",
          "--json",
        ],
        dbPath,
      );
      expect(r.error).toBeUndefined();
      const out = JSON.parse(r.stdout) as {
        items: { content: string }[];
        count: number;
      };
      expect(out.count).toBe(2);
      expect(out.items.map((n) => n.content)).toEqual(["note 4", "note 5"]);
    });
  });
});
