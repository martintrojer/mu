// v2-log-verb — `mu log` end-to-end: prose output, filters, NDJSON.
//
// The headline property is NO RAW JSON IN DEFAULT OUTPUT. Before this
// change, a 4-command session rendered as four lines of `{"impact":90,
// "updated_at":...}` because the read side still printed op payloads
// verbatim. Asserting on the absence of '{' is crude but it is exactly
// the regression that matters, and it cannot be satisfied accidentally.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { latestSeq, listLogs } from "../src/logs.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;

/** Strip SGR colour so assertions read the prose, not the escapes.
 *  `mu log` colours the verb (picocolors), which is desirable output but
 *  noise for a substring check. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

interface LogJson {
  seq: number;
  intent: string | null;
  group: string;
  kind: string;
  payload: string;
  rendered: string;
  workstreamName: string | null;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-logverb-"));
  dbPath = join(tempDir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "demo");
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** The orchestrator's canonical session. */
async function seedSession(): Promise<void> {
  const steps: string[][] = [
    ["task", "add", "a", "-t", "Build auth", "-i", "80", "-e", "3", "-w", "demo"],
    ["task", "update", "a", "--impact", "90", "-w", "demo"],
    ["task", "note", "a", "some context", "-w", "demo"],
    ["task", "close", "a", "-w", "demo", "--evidence", "tests pass"],
  ];
  for (const args of steps) {
    const r = await runCli(args, dbPath);
    expect(r.exitCode, args.join(" ")).toBeNull();
  }
}

describe("mu log renders prose, not payloads", () => {
  it("default output contains NO raw JSON", async () => {
    await seedSession();
    const r = await runCli(["log", "-w", "demo"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(plain(r.stdout)).not.toContain("{");
    expect(plain(r.stdout)).not.toContain("updated_at");
  });

  it("renders each verb as readable prose", async () => {
    await seedSession();
    const { stdout: rawOut } = await runCli(["log", "-w", "demo"], dbPath);
    const stdout = plain(rawOut);
    expect(stdout).toContain("workstream init demo");
    expect(stdout).toContain("task add a");
    expect(stdout).toContain("Build auth");
    expect(stdout).toContain("task update a impact=90");
    expect(stdout).toContain("task close a");
    expect(stdout).toContain("CLOSED");
  });

  it("suppresses parent-row touch ops (a note appeared twice before)", async () => {
    await seedSession();
    const { stdout: rawOut } = await runCli(["log", "-w", "demo"], dbPath);
    // Adding a note bumps its task's updated_at, producing a second op in
    // the same group whose payload is only updated_at. It is a real state
    // change (kept in `ops`) but not a log LINE.
    const stdout = plain(rawOut);
    expect(stdout).not.toContain("(touched)");
    const noteLines = stdout.split("\n").filter((l) => l.includes("task note a"));
    // Two notes: the operator's, and the auto CLOSE: evidence note.
    expect(noteLines).toHaveLength(2);
  });

  it("operator prose from `mu log write` is shown verbatim", async () => {
    const w = await runCli(["log", "hand written line", "-w", "demo"], dbPath);
    expect(w.exitCode).toBeNull();
    const { stdout: rawOut } = await runCli(["log", "-w", "demo"], dbPath);
    expect(plain(rawOut)).toContain("hand written line");
  });
});

describe("mu log filters", () => {
  it("--intent narrows to one structured intent", async () => {
    await seedSession();
    const { stdout: rawOut } = await runCli(
      ["log", "-w", "demo", "--intent", "task.close"],
      dbPath,
    );
    const stdout = plain(rawOut);
    expect(stdout).toContain("task close a");
    expect(stdout).not.toContain("task add");
  });

  it("--group narrows to one undo group (undo discoverability)", async () => {
    await seedSession();
    const j = await runCli(["log", "-w", "demo", "--intent", "task.close", "--json"], dbPath);
    const items = (JSON.parse(j.stdout.trim()) as { items: LogJson[] }).items;
    const group = items[0]?.group;
    expect(group).toBeDefined();
    if (group === undefined) return;
    const g = await runCli(["log", "-w", "demo", "--group", group], dbPath);
    expect(plain(g.stdout)).toContain("task close a");
    expect(plain(g.stdout)).not.toContain("workstream init");
  });

  // --kind SURVIVES as the operator channel tag: it is a different axis
  // from --intent (operator-chosen vs mu-assigned), and the documented
  // log-ledger pattern depends on it.
  it("--kind still works as the log-ledger channel tag", async () => {
    const w = await runCli(
      ["log", "pr=1234 sha=abc ci=red", "-w", "demo", "--kind", "pr-state"],
      dbPath,
    );
    expect(w.exitCode).toBeNull();
    await seedSession();
    const { stdout: rawOut } = await runCli(
      ["log", "-w", "demo", "--kind", "pr-state", "-n", "1"],
      dbPath,
    );
    const stdout = plain(rawOut);
    expect(stdout).toContain("pr=1234 sha=abc ci=red");
    expect(stdout).not.toContain("task add");
  });

  it("the ledger round-trips through --json as the docs describe", async () => {
    await runCli(["log", "pr=1 ci=green", "-w", "demo", "--kind", "pr-state"], dbPath);
    const r = await runCli(
      ["log", "-w", "demo", "--kind", "pr-state", "-n", "1", "--json"],
      dbPath,
    );
    const items = (JSON.parse(r.stdout.trim()) as { items: LogJson[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.payload).toBe("pr=1 ci=green");
    expect(items[0]?.kind).toBe("pr-state");
    expect(items[0]?.intent).toBeNull();
  });
});

describe("mu log --json", () => {
  it("carries both the structured fields AND the rendered prose", async () => {
    await seedSession();
    const r = await runCli(["log", "-w", "demo", "--json"], dbPath);
    const items = (JSON.parse(r.stdout.trim()) as { items: LogJson[] }).items;
    const close = items.find((i) => i.intent === "task.close");
    expect(close).toBeDefined();
    // Structured, so scripts switch on intent rather than parsing prose...
    expect(close?.intent).toBe("task.close");
    expect(close?.workstreamName).toBe("demo/a");
    expect(close?.group).toBeTruthy();
    // ...and rendered, so nobody has to re-derive prose from payload.
    expect(close?.rendered).toContain("task close a");
  });
});

describe("the latestSeq invariant (bit twice: R4 and R7)", () => {
  // latestSeq is the CURSOR into whatever set listLogs returns. If the two
  // disagree, `mu log --tail` starts past rows the non-tail view already
  // showed and silently skips them. The touch-op filter added here had to
  // be applied to BOTH.
  it("latestSeq equals max(seq) of what listLogs returns", async () => {
    await seedSession();
    const db = openDb({ path: dbPath });
    try {
      const scoped = listLogs(db, { workstream: "demo" });
      expect(scoped.length).toBeGreaterThan(0);
      expect(latestSeq(db, "demo")).toBe(Math.max(...scoped.map((r) => r.seq)));

      const all = listLogs(db, {});
      expect(latestSeq(db)).toBe(Math.max(...all.map((r) => r.seq)));
    } finally {
      db.close();
    }
  });

  it("the cursor does not point at a suppressed touch op", async () => {
    await seedSession();
    const db = openDb({ path: dbPath });
    try {
      // The LAST op written by `task close --evidence` is the note's
      // parent touch, which the log hides. If latestSeq returned it, a
      // --tail starting there would skip the note line itself.
      const rawMax = (db.prepare("SELECT MAX(seq) AS s FROM ops").get() as { s: number }).s;
      const shown = latestSeq(db);
      expect(shown).toBeLessThanOrEqual(rawMax);
      const visible = listLogs(db, {}).map((r) => r.seq);
      expect(visible).toContain(shown);
    } finally {
      db.close();
    }
  });
});
