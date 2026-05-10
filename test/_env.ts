// Shared env helpers for tests that touch process.env.
//
// Why this lives in its own file: identity-resolution tests (claimSelf,
// resolveActorIdentity, currentAgentName) keep silently failing when
// the test suite is run from inside a mu-spawned pane, because the
// host pane leaks MU_AGENT_NAME / TMUX_PANE / USER into the vitest
// child env. A test that asserts "fall back to $USER" can't afford to
// trust that the developer's shell has the env stripped — it has to
// strip the env itself. Centralising the cleanup here means new
// identity tests don't have to remember which three vars to nuke.

// Helper: env var deletion needs computed-key form so Biome's noDelete
// rule doesn't trip on the literal-property version.
export async function withEnv(
  key: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// Poll a predicate until it returns truthy, or fail with a useful
// message after exhausting attempts. Replaces ad-hoc fixed sleeps in
// integration tests ("wait 100ms then assert") with the correct
// pattern from AGENTS.md § Tests: "Polling loops (50ms × 10 attempts)
// when waiting for state to propagate, not fixed sleeps."
//
// `attempts * intervalMs` is the upper bound; the loop returns as soon
// as the predicate is satisfied. The default 20 × 50ms = 1s budget
// matches the existing waitForPaneGone helper in
// test/cli-task-wait.integration.test.ts.
export async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  opts: { attempts?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 50;
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const what = opts.description ?? "predicate";
  throw new Error(`pollUntil: ${what} did not become true within ${attempts} × ${intervalMs}ms`);
}

// Identity-resolution chain (resolveActorIdentity / currentAgentName)
// reads MU_AGENT_NAME, TMUX_PANE, and USER. Strip all three for the
// duration of `fn` so tests can construct the exact fallback state
// they want to verify, regardless of the surrounding shell. Inner
// withEnv() calls can still set individual vars to specific values.
export async function withCleanIdentityEnv(fn: () => Promise<void>): Promise<void> {
  await withEnv("MU_AGENT_NAME", undefined, async () => {
    await withEnv("TMUX_PANE", undefined, async () => {
      await withEnv("USER", undefined, fn);
    });
  });
}
