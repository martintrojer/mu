// Entry-point regression for wholesale tmux-server loss. The direct
// reconcile test covers a successful empty pane list; this file drives the
// user-facing `mu state --json` path through the non-zero "no server running"
// branch that listPanesInSession intentionally swallows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { addTask, claimTask, listNotes } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-state-crash-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  resetTmuxExecutor();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // noop: a failed setup should not block cleanup.
  }
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

describe("mu state --json crash recovery", () => {
  it("reaps ghost agents when tmux list-panes reports no server running", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%2", status: "busy" });
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "Design auth",
      impact: 80,
      effortDays: 2,
    });
    addTask(db, {
      localId: "impl",
      workstream: "auth",
      title: "Implement auth",
      impact: 90,
      effortDays: 3,
    });
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    await claimTask(db, "impl", { agentName: "worker-2", workstream: "auth" });

    setTmuxExecutor(async (args) => {
      if (args[0] === "list-panes" && args[1] === "-s") {
        return { stdout: "", stderr: "no server running", exitCode: 1 };
      }
      return { stdout: "", stderr: `unmocked tmux call: ${args.join(" ")}`, exitCode: 1 };
    });

    const result = await runCli(["state", "-w", "auth", "--json"], dbPath);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBeNull();
    const state = JSON.parse(result.stdout.trim()) as { agents: unknown[] };
    expect(state.agents).toEqual([]);
    expect(db.prepare("SELECT * FROM agents").all()).toEqual([]);

    const taskRows = db
      .prepare(
        `SELECT t.local_id AS localId, t.status AS status, t.owner_id AS ownerId
           FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE ws.name = ?
          ORDER BY t.local_id`,
      )
      .all("auth") as Array<{ localId: string; status: string; ownerId: number | null }>;
    expect(taskRows).toEqual([
      { localId: "design", status: "OPEN", ownerId: null },
      { localId: "impl", status: "OPEN", ownerId: null },
    ]);

    const designNote = listNotes(db, "design", "auth").find((note) => note.author === "reaper");
    const implNote = listNotes(db, "impl", "auth").find((note) => note.author === "reaper");
    expect(designNote?.content).toContain("[reaper]");
    expect(designNote?.content).toContain("previous owner worker-1");
    expect(implNote?.content).toContain("[reaper]");
    expect(implNote?.content).toContain("previous owner worker-2");

    const reapEvents = listLogs(db, { workstream: "auth", kind: "event" }).filter((row) =>
      row.payload.startsWith("task reap "),
    );
    expect(reapEvents.map((row) => row.payload).sort()).toEqual([
      "task reap design (previous owner worker-1 gone, IN_PROGRESS → OPEN)",
      "task reap impl (previous owner worker-2 gone, IN_PROGRESS → OPEN)",
    ]);
  });
});
