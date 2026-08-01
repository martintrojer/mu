// dogfood-* sweep: flag-vs-positional parity across verbs that name
// the SAME concept two different ways.
//
// Four dogfooding findings, one theme — mu was internally inconsistent
// about whether a given concept arrives as a positional or a flag:
//
//   dogfood-init-exit-code   `mu workstream init mu-foo` must exit
//                            non-zero (2, the documented usage lane),
//                            not 0. Scripting hazard: `init $n ||
//                            fallback` silently proceeds.
//   dogfood-block-multi      `mu task block --by` now accepts the same
//                            repeat/comma forms `--blocked-by` does.
//   dogfood-destroy-w-flag   `mu workstream destroy <name>` accepts the
//                            positional as an alias for -w, matching
//                            `workstream init <name>`. Same for
//                            `workstream export <name>`.
//   dogfood-note-arg-shape   `mu task note <id> --text "..."` is an
//                            alias for the positional text.
//
// Every added form is ADDITIVE: the pre-existing invocation for each
// verb is asserted alongside the new one so a future refactor can't
// quietly drop it.
//
// Fast tier: in-process runCli, per-test temp DB, no real tmux/VCS
// subprocesses, no sleeps.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

interface JsonError {
  error: string;
  message: string;
  exitCode: number;
}

interface BlockJson {
  blockedName: string;
  blockerNames: string[];
  addedEdges?: number;
  removedEdges?: number;
}

interface ShowJson {
  blockers: { name: string }[];
}

describe("flag-vs-positional parity sweep (dogfood-*)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-argshape-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedTasks(...ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = await runCli(
        ["task", "add", id, "-t", id.toUpperCase(), "-i", "5", "-e", "1", "-w", "ws"],
        dbPath,
      );
      expect(r.exitCode).toBeNull();
    }
  }

  // ─── dogfood-init-exit-code ───────────────────────────────────────

  describe("dogfood-init-exit-code: rejected workstream names exit non-zero", () => {
    it("`workstream init mu-foo` exits 2, not 0", async () => {
      const r = await runCli(["workstream", "init", "mu-foo"], dbPath);
      expect(r.error).toBeUndefined();
      // The bug report was exit=0 — the scripting hazard. Assert the
      // CODE, not just the message text.
      expect(r.exitCode).toBe(2);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/'mu-' prefix is reserved/);
    });

    it("`workstream init mu-foo --json` exits 2 with a typed envelope", async () => {
      const r = await runCli(["workstream", "init", "mu-foo", "--json"], dbPath);
      expect(r.exitCode).toBe(2);
      const env = JSON.parse(r.stderr.trim()) as JsonError;
      expect(env.error).toBe("WorkstreamNameInvalidError");
      expect(env.exitCode).toBe(2);
    });

    it("`workstream init scratch` (reserved name) exits 2", async () => {
      const r = await runCli(["workstream", "init", "scratch"], dbPath);
      expect(r.exitCode).toBe(2);
    });

    it("`workstream init bad.name` (tmux-mangling char) exits 2", async () => {
      const r = await runCli(["workstream", "init", "bad.name"], dbPath);
      expect(r.exitCode).toBe(2);
    });
  });

  // ─── dogfood-block-multi ──────────────────────────────────────────

  describe("dogfood-block-multi: --by accepts multiple blockers", () => {
    it("comma-separated `--by a,b` adds BOTH edges (was: no such task: a,b)", async () => {
      await seedTasks("a", "b", "c");
      const r = await runCli(["task", "block", "c", "--by", "a,b", "-w", "ws"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.exitCode).toBeNull();

      const show = await runCli(["task", "show", "c", "-w", "ws", "--json"], dbPath);
      const payload = JSON.parse(show.stdout.trim()) as ShowJson;
      expect(payload.blockers.map((b) => b.name).sort()).toEqual(["a", "b"]);
    });

    it("repeated `--by a --by b` adds both edges", async () => {
      await seedTasks("a", "b", "c");
      const r = await runCli(
        ["task", "block", "c", "--by", "a", "--by", "b", "-w", "ws", "--json"],
        dbPath,
      );
      expect(r.exitCode).toBeNull();
      const payload = JSON.parse(r.stdout.trim()) as BlockJson;
      expect(payload.blockerNames).toEqual(["a", "b"]);
      expect(payload.addedEdges).toBe(2);
    });

    it("mixed `--by a,b --by c` adds all three (same shape as --blocked-by)", async () => {
      await seedTasks("a", "b", "c", "d");
      const r = await runCli(
        ["task", "block", "d", "--by", "a,b", "--by", "c", "-w", "ws", "--json"],
        dbPath,
      );
      expect(r.exitCode).toBeNull();
      const payload = JSON.parse(r.stdout.trim()) as BlockJson;
      expect(payload.blockerNames).toEqual(["a", "b", "c"]);
    });

    it("single `--by a` still works and keeps the scalar blockerName field", async () => {
      await seedTasks("a", "c");
      const r = await runCli(["task", "block", "c", "--by", "a", "-w", "ws", "--json"], dbPath);
      expect(r.exitCode).toBeNull();
      const payload = JSON.parse(r.stdout.trim()) as BlockJson & { blockerName?: string };
      expect(payload.blockerName).toBe("a");
      expect(payload.blockerNames).toEqual(["a"]);
    });

    it("`unblock --by a,b` is symmetric and removes both edges", async () => {
      await seedTasks("a", "b", "c");
      await runCli(["task", "block", "c", "--by", "a,b", "-w", "ws"], dbPath);
      const r = await runCli(["task", "unblock", "c", "--by", "a,b", "-w", "ws", "--json"], dbPath);
      expect(r.exitCode).toBeNull();
      const payload = JSON.parse(r.stdout.trim()) as BlockJson;
      expect(payload.removedEdges).toBe(2);

      const show = await runCli(["task", "show", "c", "-w", "ws", "--json"], dbPath);
      expect((JSON.parse(show.stdout.trim()) as ShowJson).blockers).toEqual([]);
    });

    it("a bad id inside the list still surfaces exit 3, naming the bad id alone", async () => {
      await seedTasks("a", "c");
      const r = await runCli(["task", "block", "c", "--by", "a,nope", "-w", "ws"], dbPath);
      expect(r.exitCode).toBe(3);
      // The whole comma string must NOT be echoed back as one id —
      // that was the original confusing failure mode.
      expect(r.stderr).toMatch(/no such task: nope/);
      expect(r.stderr).not.toMatch(/a,nope/);
    });

    it("an all-empty `--by ''` is a usage error, not a silent no-op", async () => {
      await seedTasks("c");
      const r = await runCli(["task", "block", "c", "--by", "", "-w", "ws"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/at least one blocker/);
    });
  });

  // ─── dogfood-destroy-w-flag ───────────────────────────────────────

  describe("dogfood-destroy-w-flag: positional target aliases -w", () => {
    it("`workstream destroy ws` targets ws (was: too many arguments + help)", async () => {
      await seedTasks("a");
      const r = await runCli(["workstream", "destroy", "ws", "--json"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.exitCode).toBeNull();
      const payload = JSON.parse(r.stdout.trim()) as { workstreamName: string; dryRun?: boolean };
      expect(payload.workstreamName).toBe("ws");
      // Bare (no --yes) is still the dry-run half of the two-phase verb.
      expect(payload.dryRun).toBe(true);
    });

    it("`workstream destroy -w ws` (the pre-existing form) still works", async () => {
      await seedTasks("a");
      const r = await runCli(["workstream", "destroy", "-w", "ws", "--json"], dbPath);
      expect(r.exitCode).toBeNull();
      const payload = JSON.parse(r.stdout.trim()) as { workstreamName: string };
      expect(payload.workstreamName).toBe("ws");
    });

    it("positional + a DISAGREEING -w is a usage error, not a silent pick-one", async () => {
      const r = await runCli(["workstream", "destroy", "ws", "-w", "other"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/workstream given twice/);
    });

    it("--empty still refuses a named target, now naming the positional too", async () => {
      const r = await runCli(["workstream", "destroy", "ws", "--empty"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/mutually exclusive/);
    });

    it("`workstream export ws --out <dir>` accepts the positional too", async () => {
      await seedTasks("a");
      const outDir = join(tempDir, "bucket");
      const r = await runCli(["workstream", "export", "ws", "--out", outDir, "--json"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.exitCode).toBeNull();
      const payload = JSON.parse(r.stdout.trim()) as { workstreamName: string };
      expect(payload.workstreamName).toBe("ws");
    });

    it("`workstream export -w ws --out <dir>` (pre-existing form) still works", async () => {
      await seedTasks("a");
      const outDir = join(tempDir, "bucket2");
      const r = await runCli(
        ["workstream", "export", "-w", "ws", "--out", outDir, "--json"],
        dbPath,
      );
      expect(r.exitCode).toBeNull();
      expect((JSON.parse(r.stdout.trim()) as { workstreamName: string }).workstreamName).toBe("ws");
    });
  });

  // ─── dogfood-note-arg-shape ───────────────────────────────────────

  describe("dogfood-note-arg-shape: --text aliases the positional note body", () => {
    it("`task note <id> --text '...'` appends the note (was: help dump)", async () => {
      await seedTasks("a");
      const r = await runCli(["task", "note", "a", "--text", "from the flag", "-w", "ws"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.exitCode).toBeNull();

      const notes = await runCli(["task", "notes", "a", "-w", "ws", "--json"], dbPath);
      expect(notes.stdout).toMatch(/from the flag/);
    });

    it("`task note <id> '...'` (the pre-existing positional form) still works", async () => {
      await seedTasks("a");
      const r = await runCli(["task", "note", "a", "from the positional", "-w", "ws"], dbPath);
      expect(r.exitCode).toBeNull();
      const notes = await runCli(["task", "notes", "a", "-w", "ws", "--json"], dbPath);
      expect(notes.stdout).toMatch(/from the positional/);
    });

    it("both forms at once is a usage error", async () => {
      await seedTasks("a");
      const r = await runCli(["task", "note", "a", "pos", "--text", "flag", "-w", "ws"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/note text given twice/);
    });

    it("neither form is a targeted usage error naming BOTH shapes", async () => {
      await seedTasks("a");
      const r = await runCli(["task", "note", "a", "-w", "ws"], dbPath);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/note text required/);
      expect(r.stderr).toMatch(/--text/);
    });
  });
});
