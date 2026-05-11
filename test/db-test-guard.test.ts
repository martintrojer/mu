// Layer "db" of bug_test_flake_round_2: openDb() must refuse to
// touch the user's REAL default DB during tests.
//
// vitest sets process.env.VITEST in every fork, which triggers the
// guard. The guard computes the "real" path from HOME / XDG_STATE_HOME
// directly (NOT from defaultDbPath() — which would honour MU_DB_PATH
// and produce whatever temp path the test set, defeating the check).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

let originalHome: string | undefined;
let originalXdg: string | undefined;
let fakeHome: string;

beforeEach(() => {
  const homeKey = "HOME";
  const xdgKey = "XDG_STATE_HOME";
  originalHome = process.env[homeKey];
  originalXdg = process.env[xdgKey];
  // Construct a fake HOME so we can compute a deterministic "user
  // DB" path WITHOUT the test ever pointing at the real one. The
  // guard refuses to OPEN the real path; we don't want to risk the
  // test creating a real ~/.local/state/mu/mu.db on a clean box if
  // anything regresses.
  fakeHome = mkdtempSync(join(tmpdir(), "mu-db-guard-fake-home-"));
  process.env[homeKey] = fakeHome;
  delete process.env[xdgKey];
});

afterEach(() => {
  const homeKey = "HOME";
  const xdgKey = "XDG_STATE_HOME";
  if (originalHome === undefined) delete process.env[homeKey];
  else process.env[homeKey] = originalHome;
  if (originalXdg === undefined) delete process.env[xdgKey];
  else process.env[xdgKey] = originalXdg;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("openDb test-guard (bug_test_flake_round_2 Layer db)", () => {
  it("throws when path resolves to <HOME>/.local/state/mu/mu.db under VITEST", () => {
    expect(process.env.VITEST).toBeDefined();
    const realDbInFakeHome = join(fakeHome, ".local", "state", "mu", "mu.db");
    expect(() => openDb({ path: realDbInFakeHome })).toThrow(/openDb refused/);
  });

  it("permits any other path (per-test temp DB stays writable)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mu-db-guard-ok-"));
    const tempDb = join(tempDir, "mu.db");
    try {
      const db = openDb({ path: tempDb });
      expect(db).toBeDefined();
      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("respects XDG_STATE_HOME when computing the forbidden path", () => {
    const xdgKey = "XDG_STATE_HOME";
    const fakeXdg = mkdtempSync(join(tmpdir(), "mu-db-guard-fake-xdg-"));
    process.env[xdgKey] = fakeXdg;
    try {
      const realDbViaXdg = join(fakeXdg, "mu", "mu.db");
      expect(() => openDb({ path: realDbViaXdg })).toThrow(/openDb refused/);
    } finally {
      rmSync(fakeXdg, { recursive: true, force: true });
    }
  });
});
