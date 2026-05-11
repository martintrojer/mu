// audit_cli_validation_uniformity: every operator-error path must
// (1) print the error, (2) print/include the failing subcommand's
// --help, (3) exit 2.
//
// Three classes of "operator typed something wrong":
//   A. CommanderError — missing required option, unknown option,
//      unknown subcommand, missing positional argument, type-coercion
//      failure (parseImpact / parsePositiveNumber via InvalidArgumentError).
//   B. UsageError thrown inside a handler — mutex flags, range checks,
//      arity checks, anything the verb's own .action() body validates.
//   C. Typed *Invalid* domain errors that fault on a value the operator
//      typed AT THE CLI: WorkstreamNameInvalidError, ArchiveLabelInvalidError,
//      PruneOptionsInvalidError, TaskIdInvalidError.
//
// All three must produce the same surface:
//   - human path: red `error: <msg>`, then the failing command's
//     helpInformation() to stderr, exit 2
//   - --json path: { error, message, nextSteps, exitCode: 2, usage }
//     to stderr, where `usage` is the structured UsageJson rendition.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageJson } from "../src/output.js";
import { runCli } from "./_runCli.js";

interface ErrorEnvelope {
  error: string;
  message: string;
  nextSteps: unknown[];
  exitCode: number;
  usage?: UsageJson;
}

describe("audit_cli_validation_uniformity", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-validation-"));
    dbPath = join(tempDir, "mu.db");
    // Seed a workstream so the verbs that need one can resolve.
    await runCli(["workstream", "init", "scratch"], dbPath);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // ─── Class A: commander-handled errors ────────────────────────────

  describe("class A — CommanderError (parse-time)", () => {
    it("missing required option (--title): exit 2 + help block + JSON usage", async () => {
      const human = await runCli(["task", "add", "-w", "scratch"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*--title.*not specified/);
      // Help block follows the error in the same stderr stream.
      expect(human.stderr).toMatch(/Usage: mu task add/);
      expect(human.stderr).toMatch(/Options:/);

      const json = await runCli(["task", "add", "-w", "scratch", "--json"], dbPath);
      expect(json.exitCode).toBe(2);
      const env = JSON.parse(json.stderr.trim()) as ErrorEnvelope;
      expect(env.error).toBe("CommanderError");
      expect(env.exitCode).toBe(2);
      // The human-level "error: " prefix is stripped from the JSON
      // message so JSON consumers don't get "error: error: ...".
      expect(env.message).not.toMatch(/^error:/);
      expect(env.message).toMatch(/--title.*not specified/);
      expect(env.usage).toBeDefined();
      expect(env.usage?.command).toBe("mu task add");
      expect(env.usage?.synopsis).toMatch(/^mu task add/);
      // -t, --title was declared via .requiredOption() → mandatory.
      const titleOpt = env.usage?.options.find((o) => o.flags.includes("--title"));
      expect(titleOpt?.mandatory).toBe(true);
    });

    it("unknown option: exit 2 + help block + JSON usage", async () => {
      const human = await runCli(["task", "list", "-w", "scratch", "--bogus"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*unknown option.*--bogus/);
      expect(human.stderr).toMatch(/Usage: mu task list/);

      const json = await runCli(["task", "list", "-w", "scratch", "--bogus", "--json"], dbPath);
      expect(json.exitCode).toBe(2);
      const env = JSON.parse(json.stderr.trim()) as ErrorEnvelope;
      expect(env.usage?.command).toBe("mu task list");
    });

    it("unknown subcommand: exit 2 + parent help + JSON usage", async () => {
      const human = await runCli(["task", "bogus"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*unknown command.*bogus/);
      // The parent's help is shown (the subcommand "bogus" doesn't exist).
      expect(human.stderr).toMatch(/Usage: mu task/);
    });

    it("missing positional argument: exit 2 + help block", async () => {
      const human = await runCli(["agent", "send"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*missing required argument.*name/);
      expect(human.stderr).toMatch(/Usage: mu agent send/);
    });

    it("type-coercion failure (parseImpact): exit 2 + JSON usage", async () => {
      const json = await runCli(
        ["task", "add", "-w", "scratch", "-t", "x", "-i", "abc", "-e", "1", "--json"],
        dbPath,
      );
      expect(json.exitCode).toBe(2);
      const env = JSON.parse(json.stderr.trim()) as ErrorEnvelope;
      expect(env.error).toBe("CommanderError");
      expect(env.message).toMatch(/expected 1\.\.100/);
      expect(env.usage?.command).toBe("mu task add");
    });
  });

  // ─── Class B: handler-thrown UsageError ───────────────────────────

  describe("class B — UsageError (handler-thrown)", () => {
    it("--self / --for mutex: exit 2 + help block + JSON usage", async () => {
      const human = await runCli(
        ["task", "claim", "anything", "--self", "--for", "worker", "-w", "scratch"],
        dbPath,
      );
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*--self and --for are mutually exclusive/);
      // The fix versus today's behavior: handler-thrown UsageError now
      // ALSO prints the failing subcommand's --help.
      expect(human.stderr).toMatch(/Usage: mu task claim/);
      expect(human.stderr).toMatch(/--self/);
      expect(human.stderr).toMatch(/-f, --for/);

      const json = await runCli(
        ["task", "claim", "anything", "--self", "--for", "worker", "-w", "scratch", "--json"],
        dbPath,
      );
      expect(json.exitCode).toBe(2);
      const env = JSON.parse(json.stderr.trim()) as ErrorEnvelope;
      expect(env.error).toBe("UsageError");
      expect(env.exitCode).toBe(2);
      // Same usage shape as the commander path.
      expect(env.usage).toBeDefined();
      expect(env.usage?.command).toBe("mu task claim");
      const selfOpt = env.usage?.options.find((o) => o.flags === "--self");
      expect(selfOpt).toBeDefined();
    });

    it("--all / -w mutex on `mu state`: exit 2 + help block", async () => {
      const human = await runCli(["state", "--all", "-w", "scratch"], dbPath);
      expect(human.exitCode).toBe(2);
      expect(human.stderr).toMatch(/error:.*--all and -w\/--workstream are mutually exclusive/);
      expect(human.stderr).toMatch(/Usage: mu state/);
    });
  });

  // ─── Class C: typed *Invalid* domain errors ───────────────────────

  describe("class C — typed *Invalid* errors", () => {
    it("WorkstreamNameInvalidError: exit 2 + help block + JSON usage", async () => {
      const human = await runCli(["workstream", "init", "Bad-Name"], dbPath);
      expect(human.exitCode).toBe(2);
      // The typed error message itself is the operator-facing message.
      expect(human.stderr).toMatch(/error:.*Bad-Name/);
      expect(human.stderr).toMatch(/Usage: mu workstream init/);

      const json = await runCli(["workstream", "init", "Bad-Name", "--json"], dbPath);
      expect(json.exitCode).toBe(2);
      const env = JSON.parse(json.stderr.trim()) as ErrorEnvelope;
      expect(env.error).toBe("WorkstreamNameInvalidError");
      expect(env.usage?.command).toBe("mu workstream init");
    });
  });

  // ─── Cross-cutting invariants ────────────────────────────────────

  describe("invariants across all classes", () => {
    it("--help is exit 0 with no error envelope (must not regress)", async () => {
      const result = await runCli(["task", "add", "--help"], dbPath);
      // The help path goes through commander's helpDisplayed code,
      // which classifyCommanderError maps to exit 0.
      expect(result.exitCode === 0 || result.exitCode === null).toBe(true);
      expect(result.error).toBeUndefined();
      // The help text appears on stdout (commander's writeOut).
      expect(result.stdout).toMatch(/Usage: mu task add/);
    });
  });
});
