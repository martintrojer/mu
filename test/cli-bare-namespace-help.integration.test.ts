// Bare verb-namespace invocations (`mu workspace`, `mu task`, ...)
// previously printed nothing and exited 0 — looked like the verb
// succeeded silently. They now print the namespace's --help instead,
// which is what commander does by default when no `.action()` is
// attached, but which we'd lost by attaching nothing AND not telling
// commander to fall back to help.
//
// Surfaced by `bare_verb_namespaces_mu_workspace_task` in workstream
// `feedback`. The fix: each namespace's `program.command("<ns>")`
// node now has `.action(function () { (this as Command).help(); })`
// so a bare invocation routes into commander's help renderer.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./_runCli.js";

describe("bare verb-namespace prints --help instead of exiting silently", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-bare-ns-help-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // Every subcommand group that exists today. Adding/removing
  // namespaces requires updating this list.
  const namespaces = ["workspace", "task", "agent", "archive", "snapshot", "workstream"];

  for (const ns of namespaces) {
    it(`\`mu ${ns}\` prints the namespace help block`, async () => {
      const result = await runCli([ns], dbPath);
      // Help routing must NOT throw an unhandled error.
      expect(result.error).toBeUndefined();
      // commander emits help via writeOut, so it lands on stdout.
      // Some commander surfaces append a trailing "Commands:" header
      // even when empty; either stdout or stderr containing the
      // "Usage: mu <ns>" banner is fine for the operator-discovery
      // case the bug filed against.
      const combined = result.stdout + result.stderr;
      expect(combined).toContain(`Usage: mu ${ns}`);
      // Subcommand list must be non-empty: a "Commands:" header AND
      // at least one indented entry beneath it. Without this we'd
      // pass even if commander rendered an empty namespace.
      const commandsIdx = combined.indexOf("Commands:");
      expect(commandsIdx).toBeGreaterThan(-1);
      const tail = combined.slice(commandsIdx).split("\n").slice(1);
      const hasEntry = tail.some((line) => /^ {2}\S/.test(line));
      expect(hasEntry).toBe(true);
      // commander's --help path resolves to exit code 0 (or null if
      // we never enter the exit shim). Neither case is a "real
      // failure" — explicitly assert we do NOT exit non-zero.
      expect(result.exitCode === null || result.exitCode === 0).toBe(true);
    });
  }
});
