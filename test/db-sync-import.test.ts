import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DbExportManifest, buildImportPlan } from "../src/db-sync.js";
import { type Db, openDb } from "../src/db.js";
import { appendLog, latestSeq } from "../src/logs.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

let tempDir: string;
let localDb: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-db-import-plan-"));
  localDb = openDb({ path: join(tempDir, "local.db") });
});

afterEach(() => {
  localDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function machineId(db: Db): string {
  return (
    db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as {
      machine_id: string;
    }
  ).machine_id;
}

function wsId(db: Db, name: string): number {
  return (db.prepare("SELECT id FROM workstreams WHERE name = ?").get(name) as { id: number }).id;
}

function manifest(
  workstreams: DbExportManifest["workstreams"],
  sourceMachineId = "source-machine",
): DbExportManifest {
  return {
    muVersion: "test",
    schemaVersion: 8,
    machineId: sourceMachineId,
    hostname: "source-host",
    exportedAt: "2026-05-14T00:00:00.000Z",
    workstreams,
  };
}

function sourceWs(name: string, latestSeqValue: number): DbExportManifest["workstreams"][number] {
  return { name, tasks: 1, edges: 0, notes: 0, latestSeq: latestSeqValue };
}

function addWork(db: Db, workstream: string, localId: string, title = localId): void {
  addTask(db, { workstream, localId, title, impact: 50, effortDays: 1 });
}

function log(db: Db, workstream: string, payload: string): number {
  return appendLog(db, { workstream, source: "tester", kind: "message", payload }).seq;
}

function writeSync(db: Db, workstream: string, peer: string, seq: number, localSeq = seq): void {
  db.prepare(
    `INSERT OR REPLACE INTO workstream_sync (workstream_id, last_known_peer_seqs)
     VALUES ((SELECT id FROM workstreams WHERE name = ?), ?)`,
  ).run(workstream, JSON.stringify({ [peer]: seq, [`${peer}:local`]: localSeq }));
}

function expectDecision(
  summary: readonly { workstream: string; decision: string }[],
  workstream: string,
  decision: string,
): void {
  expect(summary.find((s) => s.workstream === workstream)?.decision).toBe(decision);
}

describe("importDb planning", () => {
  it("classifies source-only and local-only workstreams without touching DB files", () => {
    addWork(localDb, "beta", "b", "B local");

    const plan = buildImportPlan(localDb, manifest([sourceWs("alpha", 3)]), "source.db");

    expectDecision(plan, "alpha", "IMPORT");
    expectDecision(plan, "beta", "LEAVE_ALONE");
  });

  it("classifies IDENTICAL, FAST_FORWARD, LOCAL_AHEAD, and CONFLICT from peer seqs", () => {
    addWork(localDb, "identical", "a", "A");
    log(localDb, "identical", "local synced");
    writeSync(
      localDb,
      "identical",
      "source-machine",
      1,
      latestSeq(localDb, wsId(localDb, "identical")),
    );

    addWork(localDb, "fast", "a", "A");
    log(localDb, "fast", "local synced");
    writeSync(localDb, "fast", "source-machine", 1, latestSeq(localDb, wsId(localDb, "fast")));

    addWork(localDb, "ahead", "a", "A");
    log(localDb, "ahead", "local synced");
    writeSync(localDb, "ahead", "source-machine", 1, latestSeq(localDb, wsId(localDb, "ahead")));
    log(localDb, "ahead", "local advanced");

    addWork(localDb, "conflict", "a", "A");
    log(localDb, "conflict", "local synced");
    writeSync(
      localDb,
      "conflict",
      "source-machine",
      1,
      latestSeq(localDb, wsId(localDb, "conflict")),
    );
    log(localDb, "conflict", "local advanced");

    const plan = buildImportPlan(
      localDb,
      manifest([
        sourceWs("ahead", 1),
        sourceWs("conflict", 2),
        sourceWs("fast", 2),
        sourceWs("identical", 1),
      ]),
      "source.db",
    );

    expectDecision(plan, "identical", "IDENTICAL");
    expectDecision(plan, "fast", "FAST_FORWARD");
    expectDecision(plan, "ahead", "LOCAL_AHEAD");
    expect(plan.find((s) => s.workstream === "ahead")?.needs).toBe("re-export from this machine");
    expectDecision(plan, "conflict", "CONFLICT");
    expect(plan.find((s) => s.workstream === "conflict")?.needs).toBe("--force-source");
  });

  it("treats a source-omitted synced workstream as LOCAL_AHEAD", () => {
    ensureWorkstream(localDb, "ghost");
    writeSync(localDb, "ghost", "source-machine", 1);

    const plan = buildImportPlan(localDb, manifest([]), "source.db", ["ghost"]);

    expectDecision(plan, "ghost", "LOCAL_AHEAD");
  });

  it("honors repeated/comma only-workstream filters while planning", () => {
    addWork(localDb, "local", "a", "Local");

    const plan = buildImportPlan(
      localDb,
      manifest([sourceWs("alpha", 1), sourceWs("beta", 1)]),
      "source.db",
      ["alpha,beta", "missing"],
    );

    expect(plan.map((s) => s.workstream)).toEqual(["alpha", "beta"]);
  });

  it("does not treat same-machine exports as conflict", () => {
    addWork(localDb, "alpha", "a", "A");
    log(localDb, "alpha", "local advanced");
    const localMachine = machineId(localDb);

    const plan = buildImportPlan(
      localDb,
      manifest([sourceWs("alpha", latestSeq(localDb, wsId(localDb, "alpha")))], localMachine),
      "same-machine.db",
    );

    expectDecision(plan, "alpha", "IDENTICAL");
  });
});
