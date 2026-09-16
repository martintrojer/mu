// Dormant-workstream detection (src/dormant.ts).
//
// The two buckets are the whole feature, so most of these tests are
// about the BOUNDARY between them rather than about detection at all.
// Merging "finished" and "abandoned" into one dormant list would invite
// an operator to sweep away open work, which is the failure this module
// exists to prevent.
//
// Task timestamps are written directly with `updated_at`, because the
// verbs stamp `datetime('now')` and there is no way to add a task that
// was last touched 95 days ago through the normal surface.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  ABANDONED_IDLE_DAYS,
  checkDormantWorkstreams,
  FINISHED_IDLE_DAYS,
  findDormantWorkstreams,
} from "../src/dormant.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-dormant-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmFixtureDir(dir);
});

/** Add `n` tasks to `workstream`, all `status`, all last updated
 *  `idleDays` ago. Written as SQL because the task verbs stamp
 *  `datetime('now')` and the age is the input under test. */
function seed(
  workstream: string,
  opts: { status: "OPEN" | "IN_PROGRESS" | "CLOSED"; idleDays: number; count?: number },
): void {
  ensureWorkstream(db, workstream);
  const wsId = (
    db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as { id: number }
  ).id;
  const stamp = `-${opts.idleDays} days`;
  for (let i = 0; i < (opts.count ?? 1); i++) {
    // `local_id` is unique per workstream, and two seed() calls on one
    // workstream is the normal shape here (some closed, some open), so
    // the id has to carry the status too.
    const localId = `${opts.status.toLowerCase()}-${i}`;
    db.prepare(
      `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, 50, 1, datetime('now', ?), datetime('now', ?))`,
    ).run(wsId, localId, `task ${localId}`, opts.status, stamp, stamp);
  }
}

/** Register an agent row, so the "something is running here" exclusion
 *  can be exercised. */
function seedAgent(workstream: string): void {
  const wsId = (
    db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO agents (name, workstream_id, pane_id, cli, status, created_at, updated_at)
     VALUES ('worker-1', ?, '%1', 'pi', 'free', datetime('now'), datetime('now'))`,
  ).run(wsId);
}

const names = (opts: { currentWorkstream?: string | null } = {}): string[] =>
  findDormantWorkstreams(db, opts).map((d) => d.name);

describe("findDormantWorkstreams", () => {
  describe("the two buckets", () => {
    it("calls an all-closed, long-idle workstream `finished`", () => {
      seed("done", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 1, count: 3 });
      const found = findDormantWorkstreams(db);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ name: "done", kind: "finished", tasks: 3, unclosed: 0 });
    });

    it("calls a long-idle workstream with open tasks `abandoned`, and counts them", () => {
      seed("dead", { status: "CLOSED", idleDays: ABANDONED_IDLE_DAYS + 1, count: 2 });
      seed("dead", { status: "OPEN", idleDays: ABANDONED_IDLE_DAYS + 1, count: 1 });
      const found = findDormantWorkstreams(db);
      expect(found).toHaveLength(1);
      // `unclosed` is what makes this row different from a finished one:
      // tearing it down discards this much open work.
      expect(found[0]).toMatchObject({ name: "dead", kind: "abandoned", unclosed: 1 });
    });

    it("counts IN_PROGRESS as unclosed, not as finished", () => {
      // Otherwise a workstream whose only remaining task is mid-flight
      // would be advertised as safe to tear down.
      seed("midflight", { status: "IN_PROGRESS", idleDays: ABANDONED_IDLE_DAYS + 1 });
      expect(findDormantWorkstreams(db)[0]).toMatchObject({
        kind: "abandoned",
        unclosed: 1,
      });
    });

    it("holds open-task workstreams to the LONGER threshold", () => {
      // THE test for the split. At this age a closed-out workstream is
      // reported and one with open work is not: a fortnight away from a
      // project is a holiday, not abandonment.
      const between = FINISHED_IDLE_DAYS + 1;
      expect(between).toBeLessThan(ABANDONED_IDLE_DAYS);
      seed("closed-out", { status: "CLOSED", idleDays: between });
      seed("paused", { status: "OPEN", idleDays: between });
      expect(names()).toEqual(["closed-out"]);
    });
  });

  describe("what is not dormant", () => {
    it("ignores a recently-touched workstream, even fully closed", () => {
      seed("fresh", { status: "CLOSED", idleDays: 1 });
      expect(names()).toEqual([]);
    });

    it("ignores the workstream being worked in right now", () => {
      seed("done", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 1 });
      expect(names({ currentWorkstream: "done" })).toEqual([]);
    });

    it("ignores `scratch`, which is ephemeral by design", () => {
      // Reporting scratch as dormant tells the operator the feature is
      // working as documented.
      seed("scratch", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 99 });
      expect(names()).toEqual([]);
    });

    it("ignores a workstream with a live agent row", () => {
      seed("busy", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 1 });
      seedAgent("busy");
      expect(names()).toEqual([]);
    });

    it("ignores a task-less workstream, which is `teardown --empty`'s job", () => {
      // Otherwise one row gets two different remediations in one run.
      //
      // Backdate `created_at`: a workstream registered TODAY is excluded
      // by the idle threshold anyway, so without this the test passes
      // whether or not the zero-task guard exists.
      ensureWorkstream(db, "hollow");
      db.prepare(
        `UPDATE workstreams SET created_at = datetime('now', ?) WHERE name = 'hollow'`,
      ).run(`-${ABANDONED_IDLE_DAYS + 99} days`);
      expect(names()).toEqual([]);
    });
  });

  it("orders by idle time, longest first", () => {
    seed("older", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 50 });
    seed("newer", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 2 });
    expect(names()).toEqual(["older", "newer"]);
  });
});

describe("checkDormantWorkstreams", () => {
  it("is `ok` with no remediation when nothing is dormant", () => {
    seed("fresh", { status: "CLOSED", idleDays: 0 });
    const hazard = checkDormantWorkstreams(db);
    expect(hazard.severity).toBe("ok");
    expect(hazard.remediation).toBeUndefined();
  });

  it("stays `ok` even with findings — housekeeping is not a fault", () => {
    // `warn` would make doctor print "needs attention" forever on a box
    // that is working perfectly.
    seed("done", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 1 });
    expect(checkDormantWorkstreams(db).severity).toBe("ok");
  });

  it("names every workstream in the remediation, not just a count", () => {
    // The count is useless on its own: the names are the finding, and
    // the detail line only has room for a tally.
    seed("done", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 1 });
    seed("dead", { status: "OPEN", idleDays: ABANDONED_IDLE_DAYS + 1 });
    const hazard = checkDormantWorkstreams(db);
    const text = (hazard.remediation ?? []).join("\n");
    expect(text).toContain("done");
    expect(text).toContain("dead");
    expect(hazard.detail).toContain("2 dormant");
  });

  it("gives the two buckets DIFFERENT advice", () => {
    seed("done", { status: "CLOSED", idleDays: FINISHED_IDLE_DAYS + 1 });
    seed("dead", { status: "OPEN", idleDays: ABANDONED_IDLE_DAYS + 1 });
    const text = (checkDormantWorkstreams(db).remediation ?? []).join("\n");
    // Finished: a teardown command. Abandoned: a look-first command.
    expect(text).toContain("mu workstream teardown done --yes");
    expect(text).toContain("mu task list -w dead --status OPEN");
    // And crucially NOT a teardown for the one holding open work.
    expect(text).not.toContain("teardown dead");
  });
});
