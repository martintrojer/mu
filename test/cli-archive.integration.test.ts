// v2-archive-markers — the `mu archive` verbs end to end.
//
// The flow that matters, and the one the orchestrator asked to see: build
// a workstream, archive it, DESTROY it, restore it, and confirm
// `mu doctor --deep` reports NO drift. Drift is the specific hazard here,
// because a restore writes live rows and must record ops that explain
// them — `applyOp` alone does not (it is built for ingesting ops that
// already exist).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;

interface RestoreJson {
  label: string;
  restoredAs: string;
  tasks: number;
  edges: number;
  notes: number;
  dryRun: boolean;
  sourceDestroyed: boolean;
}

function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-cliarchive-"));
  dbPath = join(tempDir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "proj");
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  const steps: string[][] = [
    ["task", "add", "design", "-t", "Design the API", "-i", "80", "-e", "2", "-w", "proj"],
    ["task", "add", "impl", "-t", "Implement it", "-i", "60", "-e", "3", "-w", "proj"],
    ["task", "block", "impl", "--by", "design", "-w", "proj"],
    ["task", "note", "design", "REST + JSON, no GraphQL", "-w", "proj"],
    ["task", "close", "design", "-w", "proj", "--evidence", "spec signed off"],
  ];
  for (const args of steps) {
    const r = await runCli(args, dbPath);
    expect(r.exitCode, args.join(" ")).toBeNull();
  }
}

describe("archive → destroy → restore, with no drift", () => {
  it("restores a destroyed workstream and leaves the log consistent", async () => {
    await seed();

    const add = await runCli(["archive", "add", "v0-3", "-w", "proj"], dbPath);
    expect(add.exitCode).toBeNull();

    const destroy = await runCli(["workstream", "destroy", "proj", "--yes", "--no-export"], dbPath);
    expect(destroy.exitCode).toBeNull();

    // Dry run first: it must SAY the source is gone, since that is the
    // property an operator is relying on.
    const dry = await runCli(["archive", "restore", "v0-3", "--as", "recovered", "--json"], dbPath);
    expect(dry.exitCode).toBeNull();
    const dryReport = JSON.parse(dry.stdout.trim()) as RestoreJson;
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.sourceDestroyed).toBe(true);
    expect(dryReport.tasks).toBe(2);

    const applied = await runCli(
      ["archive", "restore", "v0-3", "--as", "recovered", "--yes", "--json"],
      dbPath,
    );
    expect(applied.exitCode).toBeNull();
    const report = JSON.parse(applied.stdout.trim()) as RestoreJson;
    expect(report.dryRun).toBe(false);
    expect(report.tasks).toBe(2);
    expect(report.edges).toBe(1);
    expect(report.notes).toBe(2);

    // Lossless: real titles/impacts, not insert defaults. A restore that
    // records ops under a DIFFERENT hlc than it applies silently produces
    // default-valued rows here.
    const list = await runCli(["task", "list", "-w", "recovered"], dbPath);
    expect(plain(list.stdout)).toContain("Design the API");
    expect(plain(list.stdout)).toContain("CLOSED");
    expect(plain(list.stdout)).toContain("80");

    const show = await runCli(["task", "show", "impl", "-w", "recovered"], dbPath);
    expect(plain(show.stdout)).toContain("design");

    const notes = await runCli(["task", "notes", "design", "-w", "recovered"], dbPath);
    expect(plain(notes.stdout)).toContain("REST + JSON, no GraphQL");
    expect(plain(notes.stdout)).toContain("CLOSE: spec signed off");

    // THE guard: the live rows must be explainable from the log.
    const doctor = await runCli(["doctor", "--deep"], dbPath);
    expect(plain(doctor.stdout)).toContain("drift            : ok");
    expect(plain(doctor.stdout)).not.toContain("divergence");
  });

  it("`workstream destroy --archive <label>` pins before destroying", async () => {
    await seed();
    const destroy = await runCli(
      ["workstream", "destroy", "proj", "--yes", "--no-export", "--archive", "gone", "--json"],
      dbPath,
    );
    expect(destroy.exitCode).toBeNull();
    const payload = JSON.parse(destroy.stdout.trim()) as { archived?: { label: string } };
    expect(payload.archived?.label).toBe("gone");

    // And it really restores.
    const r = await runCli(
      ["archive", "restore", "gone", "--as", "back", "--yes", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect((JSON.parse(r.stdout.trim()) as RestoreJson).tasks).toBe(2);
  });
});

describe("mu archive list", () => {
  it("lists nothing gracefully, then the label once added", async () => {
    const empty = await runCli(["archive", "list"], dbPath);
    expect(empty.exitCode).toBeNull();
    expect(plain(empty.stdout)).toContain("(no archives)");

    await seed();
    await runCli(["archive", "add", "v0-3", "-w", "proj"], dbPath);
    const listed = await runCli(["archive", "list"], dbPath);
    expect(plain(listed.stdout)).toContain("v0-3");
    expect(plain(listed.stdout)).toContain("proj");
  });

  it("`list <label>` shows the markers (the old separate `show`)", async () => {
    await seed();
    await runCli(["archive", "add", "v0-3", "-w", "proj"], dbPath);
    const r = await runCli(["archive", "list", "v0-3", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const summary = JSON.parse(r.stdout.trim()) as { label: string; markers: unknown[] };
    expect(summary.label).toBe("v0-3");
    expect(summary.markers).toHaveLength(1);
  });

  it("an unknown label exits 3", async () => {
    const r = await runCli(["archive", "list", "nope"], dbPath);
    expect(r.exitCode).toBe(3);
  });
});

describe("mu archive export reuses the workstream-export renderer", () => {
  it("writes a bucket and leaves NO trace in the DB", async () => {
    await seed();
    await runCli(["archive", "add", "v0-3", "-w", "proj"], dbPath);
    const out = join(tempDir, "bucket");
    const r = await runCli(["archive", "export", "v0-3", "--out", out, "--json"], dbPath);
    expect(r.exitCode).toBeNull();

    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
    const taskFile = join(out, "proj", "tasks", "design.md");
    expect(existsSync(taskFile)).toBe(true);
    const body = readFileSync(taskFile, "utf8");
    // Frontmatter names the ARCHIVED workstream, not the scratch one used
    // to materialise it.
    expect(body).toContain('workstream: "proj"');
    expect(body).not.toContain("zz-archive-export");
    expect(body).toContain("Design the API");

    // Export must not mutate: no scratch workstream, no scratch ops, and
    // still no drift.
    const db = openDb({ path: dbPath });
    try {
      const ws = db
        .prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name LIKE 'zz-archive-export%'")
        .get() as { n: number };
      const ops = db
        .prepare("SELECT COUNT(*) AS n FROM ops WHERE key LIKE 'zz-archive-export%'")
        .get() as { n: number };
      expect(ws.n).toBe(0);
      expect(ops.n).toBe(0);
    } finally {
      db.close();
    }
    const doctor = await runCli(["doctor", "--deep"], dbPath);
    expect(plain(doctor.stdout)).toContain("drift            : ok");
  });
});

describe("retired archive verbs are gone", () => {
  // create/remove/delete are consequences of the marker model, not scope
  // cuts: a label with no markers pins nothing, and markers are ops
  // (append-only), so removing one would mean rewriting history.
  it("create / remove / delete / search no longer exist", async () => {
    for (const verb of ["create", "remove", "delete", "search"]) {
      const r = await runCli(["archive", verb, "x"], dbPath);
      expect(r.exitCode, `archive ${verb} should not exist`).not.toBeNull();
    }
  });

  it("add / list / restore / export do exist", async () => {
    const help = await runCli(["archive", "--help"], dbPath);
    const text = plain(help.stdout);
    for (const verb of ["add", "list", "restore", "export"]) {
      expect(text, `archive ${verb} should exist`).toContain(verb);
    }
  });
});
