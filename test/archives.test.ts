// v2-archive-markers — archives as markers pinning the ops log.
//
// mu once stored archives as a COPY in five `archived_*` tables (dropped
// in R1). The rebuild is one marker op per archive, and the tests below
// are organised around the PROPERTIES that had to survive, because those
// are the contract — not the implementation.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rekey, restoreArchive } from "../src/archives/restore.js";
import {
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
  ArchiveRestoreTargetExistsError,
  addArchiveMarker,
  getArchive,
  isValidArchiveLabel,
  listArchives,
  markerFor,
  pinnedHlcs,
} from "../src/archives.js";
import { type Db, openDb, SYNCED_ENTITIES } from "../src/db.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTaskEdges, listNotes, listTasks } from "../src/tasks.js";
import { destroyWorkstream, ensureWorkstream } from "../src/workstream.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-archives-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** A workstream with tasks, an edge, and notes — enough to prove a
 *  restore is lossless across all three portable entity kinds. */
function seedProject(ws = "proj"): void {
  ensureWorkstream(db, ws);
  addTask(db, {
    localId: "design",
    workstream: ws,
    title: "Design the API",
    impact: 80,
    effortDays: 2,
  });
  addTask(db, {
    localId: "impl",
    workstream: ws,
    title: "Implement it",
    impact: 60,
    effortDays: 3,
  });
  // addBlockEdge/addNote resolve a bare local_id GLOBALLY when it is
  // unique, so seeding two workstreams with the same ids needs the edge
  // scoped explicitly — otherwise 'design' in ws B binds to ws A's row and
  // raises CrossWorkstreamEdgeError.
  addBlockEdge(db, ws, "impl", "design");
  addNote(db, "design", "REST + JSON, no GraphQL", { workstream: ws, author: "me" });
  closeTask(db, "design", { workstream: ws, evidence: "spec signed off" });
}

/** A distinct-id project, for the cross-workstream cases where two
 *  workstreams coexist and bare ids would cross-match. */
function seedNamed(ws: string, prefix: string): void {
  ensureWorkstream(db, ws);
  addTask(db, {
    localId: `${prefix}-a`,
    workstream: ws,
    title: `${prefix} A`,
    impact: 80,
    effortDays: 2,
  });
  addNote(db, `${prefix}-a`, "a note", { workstream: ws, author: "me" });
}

describe("archive labels", () => {
  it("accepts the documented shape and rejects the rest", () => {
    for (const ok of ["v0-3", "auth-2026-q1", "a", "x_y-9"]) {
      expect(isValidArchiveLabel(ok), ok).toBe(true);
    }
    for (const bad of ["", "V0-3", "9lives", "-lead", "has space", "a".repeat(65)]) {
      expect(isValidArchiveLabel(bad), bad).toBe(false);
    }
  });

  it("addArchiveMarker rejects an invalid label", () => {
    ensureWorkstream(db, "proj");
    expect(() => addArchiveMarker(db, { label: "Bad Label", workstream: "proj" })).toThrow(
      ArchiveLabelInvalidError,
    );
  });
});

describe("markers are ops", () => {
  it("one add writes exactly ONE op, with a marker entity and typed intent", () => {
    ensureWorkstream(db, "proj");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    const after = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
    expect(after - before).toBe(1);
    const row = db
      .prepare("SELECT entity, intent, key, op FROM ops ORDER BY seq DESC LIMIT 1")
      .get() as { entity: string; intent: string; key: string; op: string };
    expect(row.entity).toBe("marker");
    expect(row.intent).toBe("archive.add");
    expect(row.key).toBe("v0-3/proj");
    expect(row.op).toBe("put");
  });

  // Markers must reach peers with the ops they pin, or an archive would
  // be meaningless on the other machine.
  it("'marker' is a synced entity", () => {
    expect(([...SYNCED_ENTITIES] as string[]).includes("marker")).toBe(true);
  });
});

describe("carried property: ADDITIVE (markers are append-only)", () => {
  it("adding twice pins two moments rather than replacing one", () => {
    seedProject();
    const first = addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    addTask(db, { localId: "later", workstream: "proj", title: "L", impact: 5, effortDays: 1 });
    const second = addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    expect(second.hlc > first.hlc).toBe(true);
    expect(getArchive(db, "v0-3").markers).toHaveLength(2);
  });

  it("lastAddedAt is MAX(hlc) — additive needs no stored column", () => {
    seedProject();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    const newest = addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    expect(getArchive(db, "v0-3").lastAddedAt).toBe(newest.hlc);
  });

  it("the newest marker for a workstream is the one that restores", () => {
    seedProject();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    addTask(db, { localId: "later", workstream: "proj", title: "L", impact: 5, effortDays: 1 });
    const second = addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    expect(markerFor(db, "v0-3", "proj")?.hlc).toBe(second.hlc);
    // ...and it therefore includes the task added between the two pins.
    const r = restoreArchive(db, { label: "v0-3", as: "recovered" });
    expect(r.tasks).toBe(3);
  });
});

describe("carried property: CROSS-WORKSTREAM accumulation", () => {
  it("one label accumulates markers from several workstreams", () => {
    seedNamed("alpha", "al");
    seedNamed("beta", "be");
    addArchiveMarker(db, { label: "release", workstream: "alpha" });
    addArchiveMarker(db, { label: "release", workstream: "beta" });
    const summary = getArchive(db, "release");
    expect(summary.workstreams).toEqual(["alpha", "beta"]);
    expect(summary.markers).toHaveLength(2);
  });

  it("restore requires -w when a label covers several workstreams", () => {
    seedNamed("alpha", "al");
    seedNamed("beta", "be");
    addArchiveMarker(db, { label: "release", workstream: "alpha" });
    addArchiveMarker(db, { label: "release", workstream: "beta" });
    // Guessing between them would restore the wrong data under a name the
    // operator chose for the other one.
    expect(() => restoreArchive(db, { label: "release", as: "x" })).toThrow(ArchiveNotFoundError);
    const r = restoreArchive(db, { label: "release", workstream: "beta", as: "x" });
    expect(r.sourceWorkstream).toBe("beta");
  });

  it("listArchives groups by label", () => {
    seedNamed("alpha", "al");
    addArchiveMarker(db, { label: "one", workstream: "alpha" });
    addArchiveMarker(db, { label: "two", workstream: "alpha" });
    expect(
      listArchives(db)
        .map((a) => a.label)
        .sort(),
    ).toEqual(["one", "two"]);
  });
});

describe("carried property: OUTLIVES workstream destroy", () => {
  // THE headline property. `destroy` writes tombstones rather than
  // erasing history, so the puts below the marker are still in the log.
  it("restores a DESTROYED workstream, losslessly", async () => {
    seedProject();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    await destroyWorkstream(db, { workstream: "proj" });
    expect(listTasks(db, "proj")).toEqual([]);

    const report = restoreArchive(db, { label: "v0-3", as: "recovered" });
    expect(report.sourceDestroyed).toBe(true);
    expect(report.tasks).toBe(2);

    // Every field, not just the ids — this is what "more faithful than a
    // column-subset copy" has to mean.
    const tasks = listTasks(db, "recovered");
    const design = tasks.find((t) => t.name === "design");
    expect(design?.title).toBe("Design the API");
    expect(design?.status).toBe("CLOSED");
    expect(design?.impact).toBe(80);
    expect(design?.effortDays).toBe(2);

    // Edges survive, in the right direction.
    expect(getTaskEdges(db, "impl", "recovered").blockers).toEqual(["design"]);
    // Notes survive, including the auto CLOSE: evidence note.
    const notes = listNotes(db, "design", "recovered").map((n) => n.content);
    expect(notes).toContain("REST + JSON, no GraphQL");
    expect(notes).toContain("CLOSE: spec signed off");
  });

  it("stops AT the marker: work added after the pin is not restored", async () => {
    seedProject();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    addTask(db, { localId: "after", workstream: "proj", title: "After", impact: 5, effortDays: 1 });
    await destroyWorkstream(db, { workstream: "proj" });
    restoreArchive(db, { label: "v0-3", as: "recovered" });
    expect(
      listTasks(db, "recovered")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["design", "impl"]);
  });

  it("a task deleted BEFORE the pin stays deleted", () => {
    seedProject();
    // Tombstone below the marker: the restore must honour it.
    db.prepare("DELETE FROM tasks WHERE local_id = 'impl'").run();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    const r = restoreArchive(db, { label: "v0-3", as: "recovered" });
    expect(r.tasks).toBe(1);
    expect(listTasks(db, "recovered").map((t) => t.name)).toEqual(["design"]);
  });
});

describe("restore safety", () => {
  it("refuses to write onto an existing workstream", () => {
    seedProject();
    ensureWorkstream(db, "taken");
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    expect(() => restoreArchive(db, { label: "v0-3", as: "taken" })).toThrow(
      ArchiveRestoreTargetExistsError,
    );
  });

  it("rejects an invalid target name", () => {
    seedProject();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    expect(() => restoreArchive(db, { label: "v0-3", as: "Not Valid" })).toThrow(
      ArchiveRestoreTargetExistsError,
    );
  });

  it("dry run reports counts and writes nothing", () => {
    seedProject();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    const r = restoreArchive(db, { label: "v0-3", as: "recovered", dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.tasks).toBe(2);
    expect(
      db.prepare("SELECT 1 AS x FROM workstreams WHERE name = 'recovered'").get(),
    ).toBeUndefined();
  });

  it("an unknown label is ArchiveNotFoundError", () => {
    expect(() => getArchive(db, "nope")).toThrow(ArchiveNotFoundError);
  });

  it("the original workstream is untouched by a restore", () => {
    seedProject();
    addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    restoreArchive(db, { label: "v0-3", as: "recovered" });
    // Both exist, independently — restoring is for inspecting beside the
    // original, not replacing it.
    expect(listTasks(db, "proj")).toHaveLength(2);
    expect(listTasks(db, "recovered")).toHaveLength(2);
  });
});

describe("rekey", () => {
  // The natural key carries the workstream, so every shape has to be
  // rewritten or the replay would resurrect the ORIGINAL name.
  it("rewrites every key shape, including both sides of an edge", () => {
    expect(rekey("proj", "proj", "new")).toBe("new");
    expect(rekey("proj/t1", "proj", "new")).toBe("new/t1");
    expect(rekey("proj/t1#3", "proj", "new")).toBe("new/t1#3");
    expect(rekey("proj/a->proj/b", "proj", "new")).toBe("new/a->new/b");
  });

  it("leaves other workstreams alone", () => {
    expect(rekey("other/t1", "proj", "new")).toBe("other/t1");
    // A workstream whose name merely STARTS with the source must not match.
    expect(rekey("project/t1", "proj", "new")).toBe("project/t1");
  });
});

describe("the compaction invariant", () => {
  // Nothing compacts today. The invariant is recorded in CODE as well as
  // in the docs so a future compactor trips over it, rather than
  // rediscovering it from a support report about an empty archive.
  it("pinnedHlcs reports every pinned point", () => {
    seedNamed("alpha", "al");
    seedNamed("beta", "be");
    const a = addArchiveMarker(db, { label: "one", workstream: "alpha" });
    const b = addArchiveMarker(db, { label: "two", workstream: "beta" });
    const pinned = pinnedHlcs(db);
    expect(pinned).toContain(a.hlc);
    expect(pinned).toContain(b.hlc);
  });

  it("every op needed by an archive sits at or below a pinned hlc", () => {
    seedProject();
    const marker = addArchiveMarker(db, { label: "v0-3", workstream: "proj" });
    // The restore reads ops with hlc <= marker.hlc, so a compactor that
    // discarded anything at-or-below the newest pin would empty it.
    const below = (
      db
        .prepare("SELECT COUNT(*) AS n FROM ops WHERE hlc <= ? AND key LIKE 'proj%'")
        .get(marker.hlc) as { n: number }
    ).n;
    expect(below).toBeGreaterThan(0);
    expect(pinnedHlcs(db)).toContain(marker.hlc);
  });
});
