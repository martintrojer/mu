// CLI-level tests for `mu undo`.
//
// The SDK behaviour lives in test/undo.test.ts; this covers the verb's
// contract: dry-run-by-default, group-id discoverability, --json shape,
// the Next: block, exit codes, and the end-to-end guarantee that
// `mu doctor --deep` stays clean after an undo.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("mu undo", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-cli-undo-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmFixtureDir(tempDir);
  });

  const seed = async (): Promise<void> => {
    await runCli(["workstream", "init", "demo"], dbPath);
    await runCli(["task", "add", "a", "-t", "A", "-i", "60", "-e", "1", "-w", "demo"], dbPath);
    await runCli(["task", "add", "b", "-t", "B", "-i", "40", "-e", "1", "-w", "demo"], dbPath);
  };

  /** The group id of the newest undoable action, via the verb itself. */
  const newestGroup = async (): Promise<string> => {
    const { stdout } = await runCli(["undo", "--json"], dbPath);
    const parsed = JSON.parse(stdout) as { target: { groupId: string } };
    return parsed.target.groupId;
  };

  it("with no argument, reports what it WOULD undo and lists group ids", async () => {
    await seed();
    const { stdout, exitCode } = await runCli(["undo"], dbPath);
    expect(exitCode).toBeNull();
    // Never guesses and acts; it reports.
    expect(stdout).toContain("most recent undoable action");
    expect(stdout).toContain("recent groups");
    // Ids are DISCOVERABLE here, so the operator never needs a uuid.
    expect(stdout).toMatch(/[0-9a-f]{8}/);
    expect(stdout).toContain("task.add");
    // And nothing changed.
    const list = await runCli(["task", "list", "-w", "demo", "--json"], dbPath);
    expect((JSON.parse(list.stdout) as { count: number }).count).toBe(2);
  });

  it("exits 3 with a typed error when there is nothing to undo", async () => {
    const { stdout, stderr, exitCode } = await runCli(["undo"], dbPath);
    expect(exitCode).toBe(3);
    expect(stdout + stderr).toContain("nothing to undo");
  });

  it("is a DRY RUN by default and changes nothing", async () => {
    await seed();
    await runCli(["task", "update", "a", "--impact", "90", "-w", "demo"], dbPath);
    const group = await newestGroup();

    const { stdout, exitCode } = await runCli(["undo", group.slice(0, 8)], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("would revert");
    expect(stdout).toContain("dry-run");
    expect(stdout).toContain("impact=60");

    // Still 90: the dry run must not mutate.
    const show = await runCli(["task", "show", "a", "-w", "demo", "--json"], dbPath);
    expect((JSON.parse(show.stdout) as { task: { impact: number } }).task.impact).toBe(90);
  });

  it("--yes applies the inverse and reports the redo group", async () => {
    await seed();
    await runCli(["task", "update", "a", "--impact", "90", "-w", "demo"], dbPath);
    const group = await newestGroup();

    const { stdout, exitCode } = await runCli(["undo", group.slice(0, 8), "--yes"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("Undid");
    // The undo is itself undoable, and the output says so with the id.
    expect(stdout).toContain("itself undoable");

    const show = await runCli(["task", "show", "a", "-w", "demo", "--json"], dbPath);
    expect((JSON.parse(show.stdout) as { task: { impact: number } }).task.impact).toBe(60);
  });

  it("accepts an abbreviated group id", async () => {
    await seed();
    const group = await newestGroup();
    const { exitCode } = await runCli(["undo", group.slice(0, 8), "--yes"], dbPath);
    expect(exitCode).toBeNull();
  });

  it("exits 3 on an unknown group", async () => {
    await seed();
    const { stdout, stderr, exitCode } = await runCli(["undo", "deadbeef"], dbPath);
    expect(exitCode).toBe(3);
    expect(stdout + stderr).toContain("no ops found for group");
  });

  it("--json dry run carries the plan; --json apply carries the undo group", async () => {
    await seed();
    await runCli(["task", "update", "a", "--impact", "90", "-w", "demo"], dbPath);
    const group = await newestGroup();

    const dry = await runCli(["undo", group, "--json"], dbPath);
    const dryParsed = JSON.parse(dry.stdout) as {
      dryRun: boolean;
      groupId: string;
      intents: string[];
      superseded: boolean;
      inverses: Array<{ entity: string; key: string; op: string; fields: Record<string, unknown> }>;
      nextSteps: Array<{ command: string }>;
    };
    expect(dryParsed.dryRun).toBe(true);
    expect(dryParsed.intents).toContain("task.update");
    expect(dryParsed.superseded).toBe(false);
    expect(dryParsed.inverses[0]).toMatchObject({ entity: "task", key: "demo/a", op: "put" });
    expect(dryParsed.inverses[0]?.fields).toMatchObject({ impact: 60 });
    expect(dryParsed.nextSteps[0]?.command).toContain("--yes");

    const applied = await runCli(["undo", group, "--yes", "--json"], dbPath);
    const appliedParsed = JSON.parse(applied.stdout) as {
      dryRun: boolean;
      undoGroupId: string;
      applied: number;
    };
    expect(appliedParsed.dryRun).toBe(false);
    expect(appliedParsed.applied).toBe(1);
    expect(appliedParsed.undoGroupId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a superseded group with exit 4, then --force applies it", async () => {
    await seed();
    await runCli(["task", "update", "a", "--impact", "90", "-w", "demo"], dbPath);
    const group = await newestGroup();
    // A later action on the same field.
    await runCli(["task", "update", "a", "--impact", "95", "-w", "demo"], dbPath);

    // The dry run WARNS rather than failing, so the operator can look.
    const dry = await runCli(["undo", group, "--yes"], dbPath);
    expect(dry.exitCode).toBe(4);
    expect(dry.stdout + dry.stderr).toContain("superseded");

    // Nothing was clobbered.
    let show = await runCli(["task", "show", "a", "-w", "demo", "--json"], dbPath);
    expect((JSON.parse(show.stdout) as { task: { impact: number } }).task.impact).toBe(95);

    const forced = await runCli(["undo", group, "--yes", "--force"], dbPath);
    expect(forced.exitCode).toBeNull();
    show = await runCli(["task", "show", "a", "-w", "demo", "--json"], dbPath);
    expect((JSON.parse(show.stdout) as { task: { impact: number } }).task.impact).toBe(60);
  });

  it("the dry run of a superseded group warns without failing", async () => {
    await seed();
    await runCli(["task", "update", "a", "--impact", "90", "-w", "demo"], dbPath);
    const group = await newestGroup();
    await runCli(["task", "update", "a", "--impact", "95", "-w", "demo"], dbPath);

    const { stdout, exitCode } = await runCli(["undo", group], dbPath);
    // A preview must never fail: the operator is asking what would happen.
    expect(exitCode).toBeNull();
    expect(stdout).toContain("SUPERSEDED");
    expect(stdout).toContain("--force");
  });

  it("END TO END: undo a cascade reject, then doctor --deep reports NO drift", async () => {
    // The strongest available proof that undo did not corrupt the
    // projection: the log and the tables still agree afterwards.
    await seed();
    await runCli(["task", "block", "b", "--by", "a", "-w", "demo"], dbPath);
    await runCli(["task", "reject", "a", "-w", "demo", "--cascade", "--yes"], dbPath);

    const group = await newestGroup();
    const undone = await runCli(["undo", group, "--yes"], dbPath);
    expect(undone.exitCode).toBeNull();

    const list = await runCli(["task", "list", "-w", "demo", "--json"], dbPath);
    const items = (JSON.parse(list.stdout) as { items: Array<{ name: string; status: string }> })
      .items;
    expect(items.map((t) => t.status).sort()).toEqual(["OPEN", "OPEN"]);

    const doctor = await runCli(["doctor", "--deep"], dbPath);
    expect(doctor.exitCode).toBeNull();
    expect(doctor.stdout).toContain("rebuild matches live tables");
  });

  it("END TO END: undo a workstream destroy, then doctor --deep is clean", async () => {
    await seed();
    await runCli(["task", "block", "b", "--by", "a", "-w", "demo"], dbPath);
    await runCli(["task", "note", "a", "context", "-w", "demo"], dbPath);
    await runCli(["workstream", "destroy", "demo", "--yes"], dbPath);

    const group = await newestGroup();
    const undone = await runCli(["undo", group, "--yes"], dbPath);
    expect(undone.exitCode).toBeNull();

    const list = await runCli(["task", "list", "-w", "demo", "--json"], dbPath);
    expect((JSON.parse(list.stdout) as { count: number }).count).toBe(2);

    const doctor = await runCli(["doctor", "--deep"], dbPath);
    expect(doctor.exitCode).toBeNull();
    expect(doctor.stdout).toContain("rebuild matches live tables");
  });

  it("appears in --help", async () => {
    const { stdout } = await runCli(["--help"], dbPath);
    expect(stdout).toContain("undo");
  });
});
