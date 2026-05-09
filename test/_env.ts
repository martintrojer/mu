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
