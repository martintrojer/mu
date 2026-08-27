// Regression tests for the LOG_ONLY_INTENTS family of bugs.
//
// ONE root cause, two call sites. `emitEvent` derives an op's entity
// from its INTENT PREFIX, so `workstream.export` lands on
// entity='workstream' — a synced, projectable entity — while carrying a
// PROSE payload rather than a JSON object. Every consumer that reads ops
// by entity therefore has to exclude it by intent, and each one that
// forgot broke differently:
//
//   rebuild.ts   excluded it (the original fix; `mu doctor --deep`
//                crashed with 'Unexpected token w' before it).
//   segments.ts  did NOT — and this was the worst of the two, because
//                `encodeSegmentLine` embeds payload as RAW JSON, so
//                flushing one wrote a MALFORMED line. Then `readSegmentTail`
//                stops at the first bad record to recover its watermark,
//                so the watermark reset and every later flush re-appended
//                the whole tail. Seen in the wild: a 2.7MB segment grown
//                to 102MB with ops repeated up to 96 times.
//
// These tests pin the SHARED invariant (a log-only intent is never
// projected or flushed) rather than the two symptoms, so a third
// consumer that forgets fails here too.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { emitEvent } from "../src/logs.js";
import { LOG_ONLY_INTENTS } from "../src/rebuild.js";
import { flushSegment } from "../src/segments.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-logonly-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "proj");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by a test
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** The op the bug family hinges on: entity='workstream' (so every
 *  entity-based filter lets it through) carrying PROSE (so every
 *  JSON.parse on it throws). Emitted the same way the real code path
 *  does, rather than hand-inserted, so the test breaks if `emitEvent`
 *  stops classifying it this way. */
function emitExportEvent(): void {
  emitEvent(
    db,
    "proj",
    "workstream.export",
    "workstream export proj (out=/tmp/x, tasks=1, written=1, unchanged=0, preserved=0)",
  );
}

function exportOpRow(): { entity: string; intent: string | null; payload: string } | undefined {
  return db
    .prepare("SELECT entity, intent, payload FROM ops WHERE intent = ?")
    .get("workstream.export") as
    | { entity: string; intent: string | null; payload: string }
    | undefined;
}

describe("the shape that causes the bug", () => {
  it("emits workstream.export as entity='workstream' with a non-JSON payload", () => {
    emitExportEvent();
    const row = exportOpRow();
    expect(row, "workstream.export should be recorded").toBeDefined();
    // Both halves matter: the entity is why filters miss it, the payload
    // is why missing it crashes. If either changes, the exclusions below
    // may no longer be needed — but that is a deliberate decision, not a
    // silent drift, so assert the premise.
    expect(row?.entity).toBe("workstream");
    expect(() => JSON.parse(row?.payload ?? "")).toThrow();
    expect(LOG_ONLY_INTENTS.has("workstream.export")).toBe(true);
  });
});

describe("segment flush skips log-only intents", () => {
  it("writes only parsable lines and does not re-append on later flushes", async () => {
    addTask(db, { workstream: "proj", localId: "t1", title: "One", impact: 10, effortDays: 1 });
    emitExportEvent();

    const first = await flushSegment(db, tempDir);
    const path = first.segmentPath;
    expect(path, "flush should have written a segment").not.toBeNull();
    if (path === null) return;

    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    // Every line parses. Before the fix the export op produced a line with
    // a bare prose payload, which is not JSON at all.
    for (const line of lines) {
      expect(() => JSON.parse(line), `unparsable segment line: ${line.slice(0, 80)}`).not.toThrow();
    }
    expect(lines.some((l) => l.includes("workstream export proj"))).toBe(false);

    // The compounding half of the bug: a malformed line makes
    // readSegmentTail stop early, so the watermark rewinds and the next
    // flush re-appends everything. Flushing twice more must be a no-op.
    const before = lines.length;
    await flushSegment(db, tempDir);
    await flushSegment(db, tempDir);
    const after = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(after.length).toBe(before);

    // And no op is duplicated, which is what the growth actually looked
    // like from the operator's side.
    const hlcs = after.map((l) => (JSON.parse(l) as { hlc: string }).hlc);
    expect(new Set(hlcs).size).toBe(hlcs.length);
  });
});
