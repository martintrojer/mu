// Tests for src/fleet-hazards.ts — the three mixed-fleet hazards.
//
// (a) DB inside MU_SYNC_DIR is constructed with real temp dirs.
// (b) The network-mount check is tested against SYNTHETIC input, stated
//     plainly: mounting NFS inside a test suite is not feasible, so the
//     tests exercise `classifyFsType` (pure, takes the statfs magic
//     number) rather than the syscall. The syscall wrapper
//     (`probeFilesystem`) is covered only for "does not throw and returns
//     a known kind", which is all that can honestly be asserted here.
// (c) Case collisions are inserted directly, since `ensureWorkstream`
//     rejects invalid names and the hazard exists precisely for rows that
//     arrived some other way (from Linux, or via `mu sql`).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  checkCaseCollisions,
  checkDbInsideSyncDir,
  checkFleetHazards,
  checkNetworkMount,
  classifyFsType,
  findCaseCollisions,
  isPathInside,
  probeFilesystem,
} from "../src/fleet-hazards.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("fleet hazards", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-fleet-test-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(tempDir);
  });

  // ─── (a) DB inside the sync dir — THE footgun ────────────────────────

  describe("(a) DB inside MU_SYNC_DIR", () => {
    it("FAILS when the DB is directly inside the sync dir", () => {
      const sync = join(tempDir, "synced");
      const hazard = checkDbInsideSyncDir(join(sync, "mu.db"), sync);
      expect(hazard.severity).toBe("fail");
      expect(hazard.detail).toContain("INSIDE");
      // The remediation must explain WHY, since "don't do that" without a
      // reason gets overridden by someone who thinks they know better.
      const text = (hazard.remediation ?? []).join("\n");
      expect(text).toContain("-wal");
      expect(text).toContain("MU_DB_PATH");
    });

    it("FAILS when the DB is nested deeper inside the sync dir", () => {
      const sync = join(tempDir, "synced");
      expect(checkDbInsideSyncDir(join(sync, "a", "b", "mu.db"), sync).severity).toBe("fail");
    });

    it("FAILS when the DB path IS the sync dir", () => {
      const sync = join(tempDir, "synced");
      expect(checkDbInsideSyncDir(sync, sync).severity).toBe("fail");
    });

    it("is ok when the DB is outside the sync dir", () => {
      expect(
        checkDbInsideSyncDir(join(tempDir, "state", "mu.db"), join(tempDir, "synced")).severity,
      ).toBe("ok");
    });

    it("is ok when MU_SYNC_DIR is unset or blank (no sync configured)", () => {
      expect(checkDbInsideSyncDir("/anywhere/mu.db", undefined).severity).toBe("ok");
      expect(checkDbInsideSyncDir("/anywhere/mu.db", "   ").severity).toBe("ok");
    });

    it("does not treat a sibling with a shared prefix as nested", () => {
      // The classic prefix bug: '/sync-data' must not read as the parent
      // of '/sync-database'.
      expect(isPathInside("/home/u/sync-database/mu.db", "/home/u/sync-data")).toBe(false);
      expect(isPathInside("/home/u/sync-data/mu.db", "/home/u/sync-data")).toBe(true);
    });

    it("fires on a path that does not exist yet", () => {
      // The check must be path-based, not stat-based: on a first run the
      // DB file has not been created, and that is exactly when telling
      // the operator is most useful.
      const sync = join(tempDir, "not-created-yet");
      expect(checkDbInsideSyncDir(join(sync, "mu.db"), sync).severity).toBe("fail");
    });

    it("normalises relative and dot segments before comparing", () => {
      const sync = join(tempDir, "synced");
      expect(checkDbInsideSyncDir(join(sync, "sub", "..", "mu.db"), sync).severity).toBe("fail");
      expect(isPathInside(`${sync}/../outside/mu.db`, sync)).toBe(false);
    });
  });

  // ─── (b) network mount — SYNTHETIC input, by necessity ───────────────

  describe("(b) network mount detection", () => {
    // NOTE: these test `classifyFsType`, which takes the statfs magic
    // number directly, because a test suite cannot mount NFS. The magic
    // values are transcribed from linux/magic.h.
    const NETWORK_MAGICS: Array<[number, string]> = [
      [0x6969, "NFS"],
      [0xff534d42, "CIFS/SMB"],
      [0xfe534d42, "SMB2"],
      [0x517b, "SMBFS"],
      [0x65735546, "FUSE"],
      [0x00c36400, "Ceph"],
    ];

    for (const [magic, label] of NETWORK_MAGICS) {
      it(`classifies 0x${magic.toString(16)} (${label}) as network on linux`, () => {
        const probe = classifyFsType(magic, "linux");
        expect(probe.kind).toBe("network");
        expect(probe.label).toContain(label.split("/")[0] ?? label);
      });
    }

    it("classifies local filesystems as local", () => {
      for (const magic of [
        0xef53, // ext4
        0x9123683e, // btrfs
        0x01021994, // tmpfs
        0x58465342, // xfs
      ]) {
        expect(classifyFsType(magic, "linux").kind).toBe("local");
      }
    });

    it("returns `unknown` off Linux rather than guessing", () => {
      // macOS f_type is a small driver INDEX, not a stable magic, so
      // comparing it would produce confident nonsense. Saying "cannot
      // tell" is the honest answer.
      for (const platform of ["darwin", "win32", "freebsd"]) {
        const probe = classifyFsType(0x6969, platform);
        expect(probe.kind).toBe("unknown");
        expect(probe.label).toContain(platform);
      }
    });

    it("WARNS (not fails) on a network mount, with remediation", () => {
      const hazard = checkNetworkMount("/mnt/nfs/mu.db", { kind: "network", label: "NFS" });
      // Warn rather than fail: a single machine on an NFS home with no
      // concurrent access usually works, and refusing would lock that
      // operator out of their own tool.
      expect(hazard.severity).toBe("warn");
      expect(hazard.detail).toContain("NFS");
      expect((hazard.remediation ?? []).join("\n")).toContain("MU_DB_PATH");
    });

    it("is ok on a local mount", () => {
      expect(
        checkNetworkMount("/x/mu.db", { kind: "local", label: "local (0xef53)" }).severity,
      ).toBe("ok");
    });

    it("degrades to ok-with-caveat when the filesystem cannot be classified", () => {
      const hazard = checkNetworkMount("/x/mu.db", {
        kind: "unknown",
        label: "unrecognised (darwin)",
      });
      expect(hazard.severity).toBe("ok");
      // Says so rather than claiming a clean bill of health.
      expect(hazard.detail).toContain("not classifiable");
    });

    it("probeFilesystem returns a usable answer for a real path", () => {
      // All that can honestly be asserted without mounting anything: it
      // does not throw and returns one of the three kinds.
      const probe = probeFilesystem(join(tempDir, "mu.db"));
      expect(["local", "network", "unknown"]).toContain(probe.kind);
    });

    it("probeFilesystem walks up to an existing ancestor", () => {
      // The DB may not exist on a first run; its directory answers the
      // same question.
      const probe = probeFilesystem(join(tempDir, "does", "not", "exist", "mu.db"));
      expect(["local", "network", "unknown"]).toContain(probe.kind);
    });
  });

  // ─── (c) case-colliding workstream names ─────────────────────────────

  describe("(c) APFS case-insensitivity", () => {
    const insertRaw = (name: string): void => {
      db.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)").run(
        name,
        new Date().toISOString(),
      );
    };

    it("detects two names differing only by case", () => {
      ensureWorkstream(db, "foo");
      insertRaw("Foo");
      const collisions = findCaseCollisions(db);
      expect(collisions).toHaveLength(1);
      expect(collisions[0]?.folded).toBe("foo");
      expect([...(collisions[0]?.names ?? [])].sort()).toEqual(["Foo", "foo"]);
    });

    it("WARNS with a remediation naming the colliding pair", () => {
      ensureWorkstream(db, "auth");
      insertRaw("AUTH");
      const hazard = checkCaseCollisions(db);
      expect(hazard.severity).toBe("warn");
      expect(hazard.detail).toContain("AUTH");
      const text = (hazard.remediation ?? []).join("\n");
      expect(text).toContain("APFS");
      // A rename path, since there is no in-place rename verb.
      expect(text).toContain("mu workstream init");
    });

    it("detects three-way collisions as one group", () => {
      ensureWorkstream(db, "api");
      insertRaw("API");
      insertRaw("Api");
      const collisions = findCaseCollisions(db);
      expect(collisions).toHaveLength(1);
      expect(collisions[0]?.names).toHaveLength(3);
    });

    it("is quiet when names differ by more than case", () => {
      ensureWorkstream(db, "foo");
      ensureWorkstream(db, "bar");
      ensureWorkstream(db, "foo-2");
      expect(findCaseCollisions(db)).toEqual([]);
      expect(checkCaseCollisions(db).severity).toBe("ok");
    });

    it("is quiet on an empty DB and on a single workstream", () => {
      expect(checkCaseCollisions(db).severity).toBe("ok");
      ensureWorkstream(db, "solo");
      expect(checkCaseCollisions(db).severity).toBe("ok");
    });

    it("reports multiple independent collision groups", () => {
      ensureWorkstream(db, "foo");
      insertRaw("Foo");
      ensureWorkstream(db, "bar");
      insertRaw("BAR");
      const hazard = checkCaseCollisions(db);
      expect(hazard.detail).toContain("2 case-colliding");
    });
  });

  // ─── the aggregate ───────────────────────────────────────────────────

  describe("checkFleetHazards", () => {
    it("returns all three checks in stable order", () => {
      const hazards = checkFleetHazards(db, { dbPath: join(tempDir, "mu.db"), syncDir: undefined });
      expect(hazards.map((h) => h.name)).toEqual(["db-vs-sync", "db-filesystem", "name-case"]);
    });

    it("is all-ok on a healthy setup", () => {
      ensureWorkstream(db, "demo");
      const hazards = checkFleetHazards(db, { dbPath: join(tempDir, "mu.db"), syncDir: undefined });
      expect(hazards.every((h) => h.severity === "ok")).toBe(true);
    });

    it("surfaces the sync-dir failure through the aggregate", () => {
      const sync = join(tempDir, "synced");
      const hazards = checkFleetHazards(db, { dbPath: join(sync, "mu.db"), syncDir: sync });
      expect(hazards.find((h) => h.name === "db-vs-sync")?.severity).toBe("fail");
    });

    it("reads MU_SYNC_DIR from the environment when not passed explicitly", () => {
      const sync = join(tempDir, "envsync");
      const key = "MU_SYNC_DIR";
      const previous = process.env[key];
      process.env[key] = sync;
      try {
        const hazards = checkFleetHazards(db, { dbPath: join(sync, "mu.db") });
        expect(hazards.find((h) => h.name === "db-vs-sync")?.severity).toBe("fail");
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    });

    it("is cheap enough for the default doctor and the TUI tick", () => {
      for (let i = 0; i < 50; i++) ensureWorkstream(db, `ws-${i}`);
      const started = Date.now();
      checkFleetHazards(db, { dbPath: join(tempDir, "mu.db"), syncDir: undefined });
      expect(Date.now() - started).toBeLessThan(200);
    });
  });
});
