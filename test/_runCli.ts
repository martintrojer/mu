// Shared test helper: drive the mu CLI in-process via buildProgram() +
// parseAsync(), capturing stdout / stderr / exit code without spawning
// subprocesses.
//
// Three test files were each carrying a near-identical copy of this
// logic before extraction (test/json-output.test.ts, test/sql-multi-
// statement.test.ts, test/cli-task-add-blocked-by.test.ts). Centralised
// here so a fix to the shimming logic lands once.
//
// Usage:
//
//   import { runCli } from "./_runCli.js";
//
//   const { stdout, stderr, exitCode } = await runCli(
//     ["task", "add", "foo", "-w", "test", "-t", "Foo", "-i", "50", "-e", "1"],
//     dbPath,
//   );
//   expect(JSON.parse(stdout)).toMatchObject({ task: { localId: "foo" } });
//
// Why a function rather than a vitest fixture:
//
//   - Each test sets up its own DB (mkdtempSync); runCli just plugs
//     into MU_DB_PATH for the duration of one invocation.
//   - Multiple invocations per test (seed via add, then exercise via
//     show) are common; a fixture would force one-call-per-test.
//
// What gets captured:
//
//   stdout    — console.log(...) AND process.stdout.write(...) output.
//                The CLI uses both; emitJson goes through console.log
//                while raw scrollback goes through process.stdout.write.
//   stderr    — console.error(...) AND process.stderr.write(...).
//                Errors in --json mode go to process.stderr.write.
//   exitCode  — null if the CLI completed normally, otherwise the
//                code passed to process.exit (intercepted via shim).
//                The CLI's handle() wrapper calls process.exit on typed
//                errors; commander.exitOverride throws on parse errors.
//                Both cases land here and the test can pattern-match
//                on which.

import { buildProgram } from "../src/cli.js";

export interface Capture {
  stdout: string;
  stderr: string;
  /** null = CLI returned normally; otherwise the code passed to
   *  process.exit() OR thrown by commander.exitOverride. */
  exitCode: number | null;
  /** Defined iff buildProgram() / parseAsync() threw an unhandled
   *  error that was NOT a commander parse-error or our own exit
   *  shim. Tests should assert `error === undefined` when they
   *  expect success — a thrown TypeError mid-render would
   *  otherwise look identical to a clean exit (both stdout='',
   *  exitCode=null). Surfaced by review_test_runcli_silently_swallows_throws. */
  error?: Error;
}

export async function runCli(argv: readonly string[], dbPath: string): Promise<Capture> {
  const originalDbPath = process.env.MU_DB_PATH;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  const originalLog = console.log;
  const originalErrLog = console.error;
  const originalExit = process.exit;

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  process.env.MU_DB_PATH = dbPath;

  // biome-ignore lint/suspicious/noExplicitAny: variadic shim signature
  console.log = (...args: any[]) => {
    stdout += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };
  // biome-ignore lint/suspicious/noExplicitAny: variadic shim signature
  console.error = (...args: any[]) => {
    stderr += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };
  // biome-ignore lint/suspicious/noExplicitAny: shim signature matches what we need
  (process.stdout as any).write = (chunk: any) => {
    stdout += String(chunk);
    return true;
  };
  // biome-ignore lint/suspicious/noExplicitAny: shim signature matches what we need
  (process.stderr as any).write = (chunk: any) => {
    stderr += String(chunk);
    return true;
  };
  // The CLI's handle() wrapper calls process.exit(N) on typed errors;
  // intercept so the test process keeps running. Throw a sentinel so
  // the parseAsync awaits don't stall.
  //
  // We capture the FIRST exit code only — a verb that calls
  // `process.exit(5)` directly (e.g. cmdTaskWait on timeout) gets
  // wrapped by handle() which catches the shim Error, runs
  // emitError(), and calls process.exit(1). The first exit code is
  // the one the verb intended; the second is handle's fallback for
  // an "unknown error" that's actually our own shim. Without this,
  // tests asserting `exit 5` would see `1`. (task_wait_cross_workstream
  // surfaced this when the --json timeout test was added.)
  // biome-ignore lint/suspicious/noExplicitAny: shim signature matches what we need
  (process as any).exit = (code?: number) => {
    if (exitCode === null) exitCode = code ?? 0;
    throw new Error(`__exit__:${code ?? 0}`);
  };

  let caughtError: Error | undefined;
  try {
    const program = buildProgram();
    // exitOverride() converts commander's process.exit (on parse errors,
    // unknown options, etc.) into a thrown CommanderError. Combined with
    // our own process.exit shim above, ALL exit paths land in this catch.
    program.exitOverride();
    await program.parseAsync(["node", "mu", ...argv]);
  } catch (err) {
    // Three error classes can land here:
    //   1. our process.exit shim throws Error('__exit__:N') with the
    //      exit code already captured to `exitCode`. Expected.
    //   2. commander's exitOverride() throws CommanderError on parse
    //      errors (its `code` starts with 'commander.'). Expected.
    //   3. anything else — a real bug in the verb (TypeError mid-
    //      render, an unhandled rejection, an opendb failure not
    //      caught by handle()). MUST be surfaced so the test fails
    //      instead of silently appearing-to-succeed.
    if (err instanceof Error) {
      const msg = err.message;
      const isExitShim = msg.startsWith("__exit__:");
      // CommanderError has a string `code` like 'commander.unknownOption'.
      const code = (err as { code?: unknown }).code;
      const isCommander = typeof code === "string" && code.startsWith("commander.");
      if (!isExitShim && !isCommander) {
        caughtError = err;
      }
    } else {
      caughtError = new Error(`non-Error thrown: ${String(err)}`);
    }
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    console.log = originalLog;
    console.error = originalErrLog;
    process.exit = originalExit;
    if (originalDbPath === undefined) {
      const key = "MU_DB_PATH";
      delete process.env[key];
    } else {
      process.env.MU_DB_PATH = originalDbPath;
    }
  }

  return caughtError !== undefined
    ? { stdout, stderr, exitCode, error: caughtError }
    : { stdout, stderr, exitCode };
}
