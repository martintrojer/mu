// Fast-tier unit tests for the reserved `scratch` workstream.
//
// `scratch` is the off-the-cuff bucket (docs/VOCABULARY.md "scratch
// workstream"): it auto-creates on first spawn via `ensureWorkstream`
// but `mu workstream init scratch` is rejected loud so operators don't
// treat it as a durable crew workstream. These tests pin both halves of
// that asymmetry plus the name predicate.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  RESERVED_WORKSTREAM_NAMES,
  SCRATCH_WORKSTREAM,
  WorkstreamNameReservedError,
  assertWorkstreamInitable,
  ensureWorkstream,
  isScratchWorkstream,
  isValidWorkstreamName,
} from "../src/workstream.js";

describe("scratch reserved workstream", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-scratch-test-"));
    db = openDb({ path: join(dir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("scratch is in the reserved set and recognised as scratch", () => {
    expect(RESERVED_WORKSTREAM_NAMES.has(SCRATCH_WORKSTREAM)).toBe(true);
    expect(isScratchWorkstream("scratch")).toBe(true);
    expect(isScratchWorkstream("realws")).toBe(false);
  });

  it("scratch is still a valid name shape (so auto-create can use it)", () => {
    // Reservation is an `init`-time policy, NOT a name-shape rejection.
    expect(isValidWorkstreamName("scratch")).toBe(true);
  });

  it("assertWorkstreamInitable rejects scratch (init path)", () => {
    expect(() => assertWorkstreamInitable("scratch")).toThrow(WorkstreamNameReservedError);
    // A normal name passes.
    expect(() => assertWorkstreamInitable("realws")).not.toThrow();
  });

  it("ensureWorkstream (auto-create-on-spawn path) accepts scratch", () => {
    // The spawn/addTask path must NOT consult the reserved-name guard:
    // spawning into scratch is the whole point.
    const created = ensureWorkstream(db, "scratch");
    expect(created).toBe(true);
    const row = db.prepare("SELECT name FROM workstreams WHERE name = ?").get("scratch");
    expect(row).toEqual({ name: "scratch" });
  });

  it("WorkstreamNameReservedError carries actionable next steps", () => {
    const err = new WorkstreamNameReservedError("scratch");
    const steps = err.errorNextSteps();
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]?.command).toContain("mu agent spawn");
    expect(steps[0]?.command).toContain("scratch");
  });
});
