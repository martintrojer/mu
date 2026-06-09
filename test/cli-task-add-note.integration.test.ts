// CLI-level tests for `mu task add --note`.
//
// Initial notes are part of the task definition in many orchestration
// flows: repro steps, acceptance criteria, prior findings. The flag
// saves a second `mu task note` call while keeping the vocabulary clean
// (tasks still have titles + notes, not a new description field).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTask, listNotes } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task add --note", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-add-note-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the task and appends an initial note", async () => {
    const { stdout } = await runCli(
      [
        "task",
        "add",
        "bug",
        "-w",
        "test",
        "-t",
        "Fix bug",
        "-i",
        "80",
        "-e",
        "1",
        "--note",
        "REPRO: click save\\nEXPECTED: success",
      ],
      dbPath,
    );

    const db = openDb({ path: dbPath });
    const task = getTask(db, "bug", "test");
    const notes = listNotes(db, "bug", "test");
    db.close();

    expect(task?.title).toBe("Fix bug");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toBe("REPRO: click save\nEXPECTED: success");
    expect(stdout).toContain("initial note:");
  });

  it("honours --note-author", async () => {
    await runCli(
      [
        "task",
        "add",
        "design",
        "-w",
        "test",
        "-t",
        "Design",
        "-i",
        "50",
        "-e",
        "0.5",
        "--note",
        "CONTEXT: start here",
        "--note-author",
        "planner-1",
      ],
      dbPath,
    );

    const db = openDb({ path: dbPath });
    const notes = listNotes(db, "design", "test");
    db.close();
    expect(notes[0]?.author).toBe("planner-1");
  });

  it("includes the initial note in --json output", async () => {
    const { stdout } = await runCli(
      [
        "task",
        "add",
        "jsoncase",
        "-w",
        "test",
        "-t",
        "Json case",
        "-i",
        "10",
        "-e",
        "1",
        "--note",
        "A: b",
        "--note-author",
        "author-a",
        "--json",
      ],
      dbPath,
    );

    const parsed = JSON.parse(stdout) as { note?: { author: string | null; content: string } };
    expect(parsed.note).toEqual(expect.objectContaining({ author: "author-a", content: "A: b" }));
  });

  it("nudges adding initial context when --note was omitted", async () => {
    const { stdout } = await runCli(
      ["task", "add", "plain", "-w", "test", "-t", "Plain", "-i", "20", "-e", "1"],
      dbPath,
    );

    expect(stdout).toContain("Add initial context (or use --note next time)");
    expect(stdout).toContain("mu task note plain 'REPRO: ...\\nSCOPE: ...' -w test");
  });

  it("nudges showing notes instead of adding another note when --note was supplied", async () => {
    const { stdout } = await runCli(
      [
        "task",
        "add",
        "noted",
        "-w",
        "test",
        "-t",
        "Noted",
        "-i",
        "20",
        "-e",
        "1",
        "--note",
        "context",
      ],
      dbPath,
    );

    expect(stdout).toContain("Show notes");
    expect(stdout).toContain("mu task notes noted -w test");
    expect(stdout).not.toContain("Add initial context");
  });

  it("does not create a task when initial-note insertion fails", async () => {
    // Force the note half to fail AFTER task insertion. Because
    // cmdTaskAdd wraps addTask + addNote in one transaction, the task
    // row must roll back too.
    const db0 = openDb({ path: dbPath });
    db0.exec(`
      CREATE TRIGGER fail_task_note_insert
      BEFORE INSERT ON task_notes
      BEGIN
        SELECT RAISE(ABORT, 'note boom');
      END;
    `);
    db0.close();

    const { exitCode } = await runCli(
      [
        "task",
        "add",
        "bad",
        "-w",
        "test",
        "-t",
        "Bad",
        "-i",
        "50",
        "-e",
        "1",
        "--note",
        "this insert fails",
      ],
      dbPath,
    );
    expect(exitCode).not.toBe(0);
    const db = openDb({ path: dbPath });
    expect(getTask(db, "bad", "test")).toBeUndefined();
    db.close();
  });
});
