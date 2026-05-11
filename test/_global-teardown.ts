// Global vitest setup/teardown hook (Layer 2 of
// bug_test_suite_flake_leaks_isolation).
//
// Per vitest docs, a globalSetup file exports `setup` (or default) and
// optionally `teardown`. Either may be async. setup runs ONCE before
// the suite, teardown runs ONCE after. We use both:
//
//   setup    — sweep stale `mu-<test-prefix>-*` sessions left over
//              from a prior crashed run BEFORE the suite starts. This
//              keeps a developer's box self-cleaning across runs.
//   teardown — same sweep AFTER the suite finishes. Belt-and-
//              suspenders for the per-test afterEach `try {
//              killSession() } catch {}` cleanup: a test that
//              crashes BEFORE its afterEach (kill -9, OOM, SIGINT
//              mid-run, vitest --bail on an early failure) would
//              leave its tmux session lingering on the user's
//              shared tmux server. Audit recipe from the task notes:
//
//                tmux ls | grep '^mu-(acc|wait|...)-'
//                # → some test residue, even on green
//
// What we kill: every tmux session whose name starts with one of the
// per-suite prefixes the integration tests use (TEST_FIXTURE_PREFIXES
// below). We deliberately do NOT kill bare `mu-foo` style sessions —
// those belong to the user's actual mu workstreams (mu-tui-impl is
// the orchestrator session itself; killing it would be catastrophic).
//
// Layer 3 will move every integration test onto a dedicated `tmux -L
// <socket>` server, at which point a single `tmux -L <sock>
// kill-server` supersedes this hook. Until then, this is the safety
// net.

import { execa } from "execa";

/**
 * Per-suite prefixes used by `freshWorkstream(prefix)` calls in the
 * integration test files. Kept in sync by hand because the alternative
 * (parsing test files at globalTeardown time) is a worse coupling.
 *
 * If you add a new integration suite that calls `freshWorkstream("foo")`,
 * add `"foo"` here so its leaked sessions get swept on suite-crash.
 */
const TEST_FIXTURE_PREFIXES: readonly string[] = [
  "acc", // test/acceptance.test.ts
  "claim", // test/claim.integration.test.ts
  "kick", // test/cli-agent-kick.test.ts integration
  "stall", // test/cli-task-wait-on-stall.test.ts (mocked tmux but harmless)
  "t", // test/tmux.integration.test.ts
  "v", // test/verbs.integration.test.ts
  "wait", // test/cli-task-wait.integration.test.ts
  "wxa", // test/cli-task-wait.integration.test.ts (cross-ws)
  "wxb", // test/cli-task-wait.integration.test.ts (cross-ws)
];

/**
 * Compiled match: `^mu-(acc|claim|kick|...)-...`. We require the
 * dash-suffix so we never accidentally match `mu-tui-impl` or the
 * user's other workstreams.
 */
const TEST_SESSION_RE = new RegExp(`^mu-(?:${TEST_FIXTURE_PREFIXES.join("|")})-`);

async function sweepLeakedSessions(phase: "setup" | "teardown"): Promise<void> {
  // List sessions; tmux exits 1 with "no server running" when there's
  // no tmux running at all. Treat that as no-residue.
  const ls = await execa("tmux", ["list-sessions", "-F", "#{session_name}"], {
    reject: false,
  });
  if (ls.exitCode !== 0) return;

  const all = (ls.stdout ?? "").split("\n").filter((l) => l.length > 0);
  const leaked = all.filter((name) => TEST_SESSION_RE.test(name));
  if (leaked.length === 0) return;

  // Kill each leaked session. Best-effort — a session that's already
  // gone (raced with another teardown) is not an error.
  for (const name of leaked) {
    await execa("tmux", ["kill-session", "-t", name], { reject: false });
  }

  // Loud notice so a developer running locally sees the rescue. CI
  // can grep for this to flag suite-crash regressions.
  console.warn(
    `[mu-test global-${phase}] killed ${leaked.length} leaked tmux session(s): ${leaked.join(", ")}`,
  );
}

export async function setup(): Promise<void> {
  await sweepLeakedSessions("setup");
}

export async function teardown(): Promise<void> {
  await sweepLeakedSessions("teardown");
}
