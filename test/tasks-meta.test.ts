// Pure-function helpers from src/tasks.ts: validation, slugification,
// id derivation, status enum + drift guard, relative-time formatting.
//
// Split out of test/tasks.test.ts under
// testreview_test_files_past_800loc — these tests share zero state
// with the CRUD / lifecycle / wait suites and only need a DB for the
// idFromTitle collision check.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relTime } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import {
  TASK_STATUS_LIST,
  TaskExistsError,
  addTask,
  idFromTitle,
  isTaskStatus,
  isValidTaskId,
  slugifyTitle,
} from "../src/tasks.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tasks-meta-"));
  db = openDb({ path: join(tempDir, "mu.db") });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── isValidTaskId ─────────────────────────────────────────────────────

describe("isValidTaskId", () => {
  it("accepts lowercase identifiers with alnum / _ / -", () => {
    expect(isValidTaskId("design")).toBe(true);
    expect(isValidTaskId("design_auth")).toBe(true);
    expect(isValidTaskId("design-auth")).toBe(true);
    expect(isValidTaskId("a")).toBe(true);
    expect(isValidTaskId("a".repeat(64))).toBe(true);
  });

  it("rejects names not starting with a letter", () => {
    expect(isValidTaskId("1design")).toBe(false);
    expect(isValidTaskId("_design")).toBe(false);
    expect(isValidTaskId("-design")).toBe(false);
  });

  it("rejects uppercase / spaces / special chars / >64 chars", () => {
    expect(isValidTaskId("Design")).toBe(false);
    expect(isValidTaskId("design auth")).toBe(false);
    expect(isValidTaskId("design/auth")).toBe(false);
    expect(isValidTaskId("design.auth")).toBe(false);
    expect(isValidTaskId("")).toBe(false);
    expect(isValidTaskId("a".repeat(65))).toBe(false);
  });
});

// ─── slugifyTitle / idFromTitle / mu_ reservation ─────────────────

describe("slugifyTitle", () => {
  it("lowercases and replaces non-alnum runs with single underscore", () => {
    expect(slugifyTitle("Build the auth module")).toBe("build_the_auth_module");
    expect(slugifyTitle("FILES: foo.ts (refactor)")).toBe("files_foo_ts_refactor");
  });

  it("trims leading/trailing underscores", () => {
    expect(slugifyTitle("   wat   ")).toBe("wat");
    expect(slugifyTitle("...spaces...")).toBe("spaces");
  });

  it("prefixes t_ when the slug starts with a digit", () => {
    expect(slugifyTitle("2024 retro")).toBe("t_2024_retro");
  });

  // Post schema_v5_cleanups: titles starting with `Mu ...` slugify
  // to `mu_...` directly — the reserved-prefix gymnastics that
  // rewrote them to `t_mu_...` are gone (no global namespace in v5).
  it("slugs starting with mu_ are accepted as-is (no reservation in v5)", () => {
    expect(slugifyTitle("Mu smoke test")).toBe("mu_smoke_test");
    expect(slugifyTitle("mu testing")).toBe("mu_testing");
    expect(slugifyTitle("MU_THING")).toBe("mu_thing");
  });

  it("caps a one-giant-word title at the 40-char soft cap (no underscore to break on)", () => {
    const long = "x".repeat(100);
    expect(slugifyTitle(long).length).toBe(40);
  });

  it("trims at the last underscore at-or-before 40 chars (word boundary)", () => {
    // Title with several segments; segment boundaries fall at
    // positions that let us assert a clean cut.
    const title = "Refactor the authentication and authorisation modules end to end";
    const slug = slugifyTitle(title);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/_$/); // never trailing underscore
    // The cut must happen on a word boundary, so the last segment
    // must be a complete word from the original title.
    expect(["refactor_the_authentication_and", "refactor_the_authentication"]).toContain(slug);
  });

  it("prefers the soft cap when the title fits below it", () => {
    const slug = slugifyTitle("Build auth module");
    expect(slug).toBe("build_auth_module");
    expect(slug.length).toBeLessThan(40);
  });

  it("throws on a title that yields an empty slug", () => {
    expect(() => slugifyTitle("!!!")).toThrow(/empty slug/);
    expect(() => slugifyTitle("")).toThrow(/empty slug/);
  });
});

describe("idFromTitle", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "build_auth",
      workstream: "auth",
      title: "Build auth",
      impact: 50,
      effortDays: 1,
    });
  });

  it("returns the slug when no collision", () => {
    expect(idFromTitle(db, "auth", "Ship feature")).toBe("ship_feature");
  });

  it("appends _2, _3, … on collision", () => {
    expect(idFromTitle(db, "auth", "Build auth")).toBe("build_auth_2");
    addTask(db, {
      localId: "build_auth_2",
      workstream: "auth",
      title: "x",
      impact: 1,
      effortDays: 1,
    });
    expect(idFromTitle(db, "auth", "Build auth")).toBe("build_auth_3");
  });
});

// Post schema_v5_cleanups: `mu_` is no longer a reserved prefix.
// v5's per-workstream UNIQUE on (workstream_id, local_id) replaces
// the old global namespace; nothing system-generated lives in a
// shared global slot anymore. The mu_ ids that used to be rejected
// are now perfectly valid local_ids.
describe("mu_ prefix is a fine local_id (post schema_v5_cleanups)", () => {
  it("isValidTaskId accepts mu_ prefix", () => {
    expect(isValidTaskId("mu_foo")).toBe(true);
    // Length-1 names like `mu_` still fail because they need at least
    // a leading letter; `mu_` is a letter + `_` which IS valid.
    expect(isValidTaskId("mu_")).toBe(true);
    expect(isValidTaskId("music")).toBe(true);
    expect(isValidTaskId("mu")).toBe(true);
  });

  it("addTask accepts an mu_ id and the per-workstream UNIQUE catches collisions", () => {
    addTask(db, {
      localId: "mu_internal",
      workstream: "auth",
      title: "x",
      impact: 1,
      effortDays: 1,
    });
    // Same id in same workstream: TaskExistsError (per-workstream UNIQUE).
    expect(() =>
      addTask(db, {
        localId: "mu_internal",
        workstream: "auth",
        title: "x",
        impact: 1,
        effortDays: 1,
      }),
    ).toThrow(TaskExistsError);
    // Same id in a DIFFERENT workstream: legal (per-workstream scope).
    const other = addTask(db, {
      localId: "mu_internal",
      workstream: "other",
      title: "x",
      impact: 1,
      effortDays: 1,
    });
    expect(other.name).toBe("mu_internal");
    expect(other.workstreamName).toBe("other");
  });
});

// ─── isTaskStatus / TASK_STATUS_LIST drift guard ───────────────────

describe("isTaskStatus", () => {
  it("recognises the three valid statuses", () => {
    expect(isTaskStatus("OPEN")).toBe(true);
    expect(isTaskStatus("IN_PROGRESS")).toBe(true);
    expect(isTaskStatus("CLOSED")).toBe(true);
  });

  it("rejects garbage and case variants (callers should upper-case first)", () => {
    expect(isTaskStatus("open")).toBe(false);
    expect(isTaskStatus("RESOLVED")).toBe(false); // not in the enum
    expect(isTaskStatus("")).toBe(false);
    expect(isTaskStatus("OPEN ")).toBe(false);
  });
});

describe("TASK_STATUS_LIST mirrors every TaskStatus", () => {
  it("contains every legal status in canonical order", () => {
    // If a future task status is added to TaskStatus / TASK_STATUSES
    // but the LIST helper isn't kept in sync, every CLI surface that
    // names statuses (--help, error messages, --status validators)
    // will silently lie. Guard rail against that.
    expect(TASK_STATUS_LIST).toBe("OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED");
  });
});

// ─── relTime ────────────────────────────────────────────────────────

describe("relTime", () => {
  it("formats sub-minute / minute / hour / day / week buckets", () => {
    expect(relTime(0)).toBe("0s");
    expect(relTime(45_000)).toBe("45s");
    expect(relTime(5 * 60_000)).toBe("5m");
    expect(relTime(3 * 3600_000)).toBe("3h");
    expect(relTime(2 * 86_400_000)).toBe("2d");
    expect(relTime(14 * 86_400_000)).toBe("2w");
  });

  it("clamps negative durations (clock skew safety)", () => {
    expect(relTime(-5_000)).toBe("0s");
  });
});
