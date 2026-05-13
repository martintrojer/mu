// Regression test for `review_substrate_delete_agent_not_transactional`:
// the reaper sequence inside `deleteAgent` (snapshot stuck tasks → DELETE
// agent row → per-task UPDATE + addNote + emitEvent) MUST run inside a
// single SQLite transaction. If a throw escapes mid-loop (e.g. addNote
// hits a NOT NULL regression, FK race after workstream destroy, OOM),
// the whole sequence MUST roll back — agent row still present, every
// stuck task still claimed by it, no `task reap` event leaked. Without
// the transaction wrapper, the agent row would already be DELETEd (FK
// CASCADE clears tasks.owner_id) but only PART of the reaper trail
// would be written: leftover IN_PROGRESS tasks with no owner and no
// `[reaper]` note explaining how they got there.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, getAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { addTask, claimTask, getTask } from "../src/tasks.js";

describe("deleteAgent reaper transactional rollback", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-reaper-tx-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rolls back the entire sequence if addNote throws mid-loop", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "Design auth",
      impact: 80,
      effortDays: 2,
    });
    addTask(db, {
      localId: "build",
      workstream: "auth",
      title: "Build auth",
      impact: 70,
      effortDays: 3,
    });
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    await claimTask(db, "build", { agentName: "worker-1", workstream: "auth" });

    // Sanity: both tasks IN_PROGRESS owned by worker-1 going in.
    expect(getTask(db, "design", "auth")?.status).toBe("IN_PROGRESS");
    expect(getTask(db, "design", "auth")?.ownerName).toBe("worker-1");
    expect(getTask(db, "build", "auth")?.status).toBe("IN_PROGRESS");
    expect(getTask(db, "build", "auth")?.ownerName).toBe("worker-1");

    // Inject a failure into the FIRST per-task `addNote` call so the
    // reaper throws AFTER the DELETE has executed but BEFORE the loop
    // finishes. We patch the underlying `db.prepare` to substitute the
    // INSERT INTO task_notes statement with one whose `.run()` throws.
    // This exercises the real reaper path including the DELETE — the
    // failure point we care about for rollback semantics. Without the
    // transaction wrapper this leaves the agent row gone + tasks
    // ownerless + no [reaper] notes; with the wrapper the whole
    // sequence rolls back.
    const originalPrepare = db.prepare.bind(db);
    let throwingHooked = false;
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes("INSERT INTO task_notes")) {
        throwingHooked = true;
        return new Proxy(stmt, {
          get(target, prop, recv) {
            if (prop === "run") {
              return () => {
                throw new Error("simulated reaper failure inside addNote");
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      }
      return stmt;
    }) as typeof db.prepare;

    expect(() => deleteAgent(db, "worker-1", "auth")).toThrow(/simulated reaper failure/);
    expect(throwingHooked).toBe(true);

    // Restore for the rest of the assertions (we want real reads).
    (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;

    // (a) the agent row IS still present (rollback worked).
    const agentAfter = getAgent(db, "worker-1", "auth");
    expect(agentAfter).toBeTruthy();
    expect(agentAfter?.name).toBe("worker-1");

    // (b) the stuck tasks are still claimed by the agent (status +
    //     owner unchanged).
    for (const localId of ["design", "build"] as const) {
      const t = getTask(db, localId, "auth");
      expect(t?.status).toBe("IN_PROGRESS");
      expect(t?.ownerName).toBe("worker-1");
    }

    // (c) no `task reap` event leaked into agent_logs.
    const reapEvents = listLogs(db, { kind: "event" }).filter((r) =>
      r.payload.startsWith("task reap "),
    );
    expect(reapEvents).toHaveLength(0);
  });

  it("commits the whole sequence on the happy path (control)", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "Design auth",
      impact: 80,
      effortDays: 2,
    });
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });

    expect(deleteAgent(db, "worker-1", "auth")).toBe(true);
    expect(getAgent(db, "worker-1", "auth")).toBeFalsy();

    const after = getTask(db, "design", "auth");
    expect(after?.status).toBe("OPEN");
    expect(after?.ownerName).toBeNull();

    const reapEvents = listLogs(db, { kind: "event" }).filter((r) =>
      r.payload.startsWith("task reap design"),
    );
    expect(reapEvents).toHaveLength(1);
  });
});
