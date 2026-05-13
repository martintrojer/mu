// CLI tests for the `<workstream>/<name>` qualified entity-arg form.
//
// verb_arg_qualified_workstream_name (Phase 3 of the OUTPUT_LABELS_AUDIT):
// every verb that takes a task / agent / workspace name now
// accepts EITHER:
//   - bare `<name>`           → resolves via current workstream context
//   - qualified `<ws>/<name>` → no -w needed; resolves directly
// Plus an ambiguity error when bare + no resolved -w + ≥2 workstreams
// share the name.
//
// Driven via runCli() so we exercise the real commander wiring (incl.
// option resolution, error handler exit codes, JSON shape).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyQualifiedRef, parseQualifiedRef } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("parseQualifiedRef (unit)", () => {
  it("bare name → workstream undefined, name = input", () => {
    expect(parseQualifiedRef("design")).toEqual({ name: "design" });
  });

  it("qualified ref → split on first '/'", () => {
    expect(parseQualifiedRef("auth/design")).toEqual({ workstream: "auth", name: "design" });
  });

  it("only first '/' is the splitter (entity names today exclude '/'; defensive)", () => {
    // Names today are restricted to [a-z0-9_-]; this test pins the
    // contract so a future name-charset change has to revisit it.
    expect(parseQualifiedRef("a/b/c")).toEqual({ workstream: "a", name: "b/c" });
  });

  it("trailing '/' = empty name", () => {
    expect(parseQualifiedRef("auth/")).toEqual({ workstream: "auth", name: "" });
  });
});

describe("applyQualifiedRef (sync glue)", () => {
  it("bare → no opts mutation, returns input unchanged", () => {
    const opts: { workstream?: string } = {};
    expect(applyQualifiedRef("design", opts)).toBe("design");
    expect(opts.workstream).toBeUndefined();
  });

  it("qualified + no -w → pushes workstream onto opts, returns bare name", () => {
    const opts: { workstream?: string } = {};
    expect(applyQualifiedRef("auth/design", opts)).toBe("design");
    expect(opts.workstream).toBe("auth");
  });

  it("qualified + matching -w → no-op match, returns bare name", () => {
    const opts: { workstream?: string } = { workstream: "auth" };
    expect(applyQualifiedRef("auth/design", opts)).toBe("design");
    expect(opts.workstream).toBe("auth");
  });

  it("qualified + conflicting -w → throws UsageError", () => {
    const opts: { workstream?: string } = { workstream: "other" };
    expect(() => applyQualifiedRef("auth/design", opts)).toThrow(/conflicts with --workstream/);
  });
});

describe("CLI: qualified entity refs", () => {
  let tempDir: string;
  let dbPath: string;

  // Save + restore env keys we mutate so we don't pollute sibling test
  // files (vitest runs each file in its own worker, but the acceptance
  // test reads $TMUX at module-load and would observe whatever we left
  // behind if it shared the worker).
  let savedMuSession: string | undefined;
  let savedTmux: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-qref-"));
    dbPath = join(tempDir, "mu.db");
    const db: Db = openDb({ path: dbPath });
    ensureWorkstream(db, "wsa");
    ensureWorkstream(db, "wsb");
    // Same task local_id in both — ambiguity surface.
    addTask(db, {
      localId: "design",
      workstream: "wsa",
      title: "wsa design",
      impact: 50,
      effortDays: 1,
    });
    addTask(db, {
      localId: "design",
      workstream: "wsb",
      title: "wsb design",
      impact: 50,
      effortDays: 1,
    });
    // A task only in wsa — disambiguates without -w (single match).
    addTask(db, {
      localId: "only-in-a",
      workstream: "wsa",
      title: "only in wsa",
      impact: 10,
      effortDays: 1,
    });
    db.close();
    // Ensure the test process can't accidentally resolve a workstream
    // via the standard chain — we want to exercise the bare+no-context
    // path explicitly.
    savedMuSession = process.env.MU_SESSION;
    savedTmux = process.env.TMUX;
    const keys = ["MU_SESSION", "TMUX"];
    for (const k of keys) delete process.env[k];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (savedMuSession !== undefined) process.env.MU_SESSION = savedMuSession;
    if (savedTmux !== undefined) process.env.TMUX = savedTmux;
  });

  it("bare ref + -w resolves the right workstream's task (existing behaviour)", async () => {
    const { stdout, exitCode, error } = await runCli(
      ["task", "show", "design", "-w", "wsa", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as {
      task: { workstreamName: string; title: string };
    };
    expect(parsed.task.workstreamName).toBe("wsa");
    expect(parsed.task.title).toBe("wsa design");
  });

  it("qualified ref resolves directly, no -w needed", async () => {
    const { stdout, exitCode, error } = await runCli(
      ["task", "show", "wsb/design", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as {
      task: { workstreamName: string; title: string };
    };
    expect(parsed.task.workstreamName).toBe("wsb");
    expect(parsed.task.title).toBe("wsb design");
  });

  it("qualified ref overrides $MU_SESSION", async () => {
    process.env.MU_SESSION = "wsa";
    try {
      const { stdout } = await runCli(["task", "show", "wsb/design", "--json"], dbPath);
      const parsed = JSON.parse(stdout.trim()) as { task: { workstreamName: string } };
      expect(parsed.task.workstreamName).toBe("wsb");
    } finally {
      const k = "MU_SESSION";
      delete process.env[k];
    }
  });

  it("qualified ref + matching -w works (no conflict)", async () => {
    const { stdout, error } = await runCli(
      ["task", "show", "wsa/design", "-w", "wsa", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as { task: { workstreamName: string } };
    expect(parsed.task.workstreamName).toBe("wsa");
  });

  it("qualified ref + conflicting -w → exit 2 (usage)", async () => {
    const { stderr, exitCode } = await runCli(["task", "show", "wsa/design", "-w", "wsb"], dbPath);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/conflicts with --workstream/);
  });

  it("bare ref + ambiguous (≥2 workstreams) + no -w → NameAmbiguousError exit 4 listing candidates", async () => {
    const { stdout, stderr, exitCode } = await runCli(["task", "show", "design"], dbPath);
    expect(exitCode).toBe(4);
    // Both workstream candidates appear in the message.
    const out = stdout + stderr;
    expect(out).toMatch(/wsa/);
    expect(out).toMatch(/wsb/);
    // "in 2 workstreams" or similar.
    expect(out).toMatch(/2 workstreams/);
  });

  it("bare ref + only one match across workstreams + no -w → resolves via single match", async () => {
    const { stdout, exitCode, error } = await runCli(
      ["task", "show", "only-in-a", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as { task: { workstreamName: string } };
    expect(parsed.task.workstreamName).toBe("wsa");
  });

  it("bare ref + zero matches anywhere + no -w → UsageError exit 2 (workstream required)", async () => {
    const { stderr, exitCode } = await runCli(["task", "show", "ghost"], dbPath);
    expect(exitCode).toBe(2);
    // The standard 'workstream required' surface from resolveWorkstream.
    expect(stderr).toMatch(/workstream required/);
  });

  it("qualified ref works for `mu task close` (write verb path)", async () => {
    const { exitCode, error } = await runCli(
      ["task", "close", "wsb/design", "--evidence", "test", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    // wsb's design CLOSED, wsa's untouched.
    const db = openDb({ path: dbPath });
    expect(getTask(db, "design", "wsa")?.status).toBe("OPEN");
    expect(getTask(db, "design", "wsb")?.status).toBe("CLOSED");
    db.close();
  });

  it("`mu task tree` accepts qualified refs", async () => {
    const { stdout, error } = await runCli(["task", "tree", "wsb/design", "--json"], dbPath);
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout.trim()) as { root: { task: { workstreamName: string } } };
    expect(parsed.root.task.workstreamName).toBe("wsb");
  });

  it("`mu task wait` accepts qualified refs in positional list", async () => {
    // Close wsb's design then wait on it via qualified ref — should
    // succeed with a tiny timeout (already CLOSED at wait time).
    const db = openDb({ path: dbPath });
    db.prepare(
      "UPDATE tasks SET status='CLOSED' WHERE local_id='design' AND workstream_id=(SELECT id FROM workstreams WHERE name='wsb')",
    ).run();
    db.close();
    const { exitCode, error } = await runCli(
      ["task", "wait", "wsb/design", "--timeout", "1", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
  });
});
