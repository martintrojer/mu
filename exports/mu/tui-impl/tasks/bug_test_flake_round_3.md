---
id: "bug_test_flake_round_3"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.3
roi: 250.00
owner: null
created_at: "2026-05-11T18:07:33.911Z"
updated_at: "2026-05-11T18:51:05.517Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: post-L1+L2+L3 + round-2 — bare-name tmux residue (mu-alpha, mu-demo, mu-ws…) survives sweep regex; legacy tests still hardcode short names that BYPASS the freshWorkstream() prefix discipline

## Notes (2)

### #1 by "π - mu", 2026-05-11T18:08:31.254Z

```
SYMPTOM (round 3, observed 2026-05-11 post-L1+L2+L3 + round-2)
--------------------------------------------------------------
After bug_test_flake_round_2 closed, the user ran `npm test` and
then checked tmux:

    mu                       # which calls workstream list
    Workstreams (12): alpha, beta, demo, gamma, gchatui, infer-rs,
                      scratch, tui, tui-impl, ws, ws2, feedback

`mu workstream list` is the union of DB rows and tmux sessions on
the default socket. So:

  - Real DB rows (5):  feedback, gchatui, infer-rs, tui, tui-impl
  - Default-socket tmux residue (7): alpha, beta, demo, gamma,
                                     scratch, ws, ws2

All 7 leaked sessions had timestamps in the 18:57-18:58 window —
the exact test-suite run after L1+L2+L3+round-2 landed. The DB
hard-guard from round 2 worked (no DB leak this run). But sessions
ARE still landing on the user's default socket.

WHY THE SWEEP MISSES THEM
-------------------------
test/_global-teardown.ts has:

    const TEST_FIXTURE_PREFIXES: readonly string[] = [
      "acc", "claim", "kick", "stall", "t", "v", "wait", "wxa", "wxb",
    ];
    const TEST_SESSION_RE = new RegExp(
      `^mu-(?:${TEST_FIXTURE_PREFIXES.join("|")})-`
    );

So the sweep ONLY kills sessions matching `^mu-(acc|claim|kick|
stall|t|v|wait|wxa|wxb)-`. Bare names `mu-alpha`, `mu-demo`,
`mu-ws`, `mu-ws2`, `mu-scratch`, `mu-beta`, `mu-gamma` don't have
the trailing-dash prefix structure — they NEVER match the regex.

WHY THE SESSIONS ARE THERE AT ALL (Layer 3 was supposed to fix this)
--------------------------------------------------------------------
The Layer 3 design routes every src/tmux.ts call through the
private `mu-test-<pid>-<ts>-<rand>` socket via `MU_TMUX_SOCKET`.
Since `runCli` runs the CLI in-process, MU_TMUX_SOCKET IS visible
to `mu workstream init`. That MU_TMUX_SOCKET routing should have
created sessions on the PRIVATE socket, not the default one.

BUT — bug_test_flake_round_2 added test/_setup.ts which scrubs
MU_* env vars in EACH FORK. The allowlist correctly preserves
MU_TMUX_SOCKET. HOWEVER, this only matters if MU_TMUX_SOCKET was
set BEFORE the fork started. Order of operations:

  1. Main process imports test/_global-teardown.ts → runs its
     module-level constant `TEST_SOCKET = mu-test-<...>` (BUT
     does NOT set process.env.MU_TMUX_SOCKET yet — only setup()
     does that).
  2. Main process calls vitest pool → forks workers.
  3. setup() runs in main process, sets process.env.MU_TMUX_SOCKET.
  4. ← TOO LATE — forks already started without it.

If that's the order, every fork runs without MU_TMUX_SOCKET set,
so src/tmux.ts falls through to the default socket. Layer 3 is
silently ineffective.

VERIFY THIS HYPOTHESIS
----------------------
Add a single console.error to test/_setup.ts:

    console.error("[mu-test fork] MU_TMUX_SOCKET=", process.env.MU_TMUX_SOCKET);

Run the suite once. If the printed value is `undefined`, the
hypothesis is confirmed: setup() runs AFTER fork spawn, so its
process.env mutation never reaches the workers.

vitest's `globalSetup` semantics: yes, it runs in the MAIN process
ONCE before all workers, but its env mutations DO need to be
explicit about being inherited. vitest provides setupFiles for
per-fork init, but globalSetup setting process.env doesn't
auto-propagate to forks.

FIX (TWO PARTS, INDEPENDENT)
----------------------------

PART A — actually propagate MU_TMUX_SOCKET to forks.

vitest's globalSetup CAN return an env object that the workers
inherit. From the vitest docs:

    export async function setup({ provide }) {
      provide("MU_TMUX_SOCKET", TEST_SOCKET);
    }

…and forks read it via `inject("MU_TMUX_SOCKET")`. OR cleaner: use
`process.env.MU_TMUX_SOCKET = ...` AT MODULE LOAD TIME (before
setup() returns), so the env mutation happens before vitest spawns
forks. Move the assignment from setup() into the module body:

    // _global-teardown.ts (module body)
    const TEST_SOCKET = `mu-test-${process.pid}-...`;
    process.env.MU_TMUX_SOCKET = TEST_SOCKET;  // ← do this NOW

    // setup() then just bootstraps the actual server:
    export async function setup() {
      await execa("tmux", ["-L", TEST_SOCKET, "-f", "/dev/null", "start-server"]);
      // optional: sweep default-socket residue from prior runs
    }

This is the cleanest fix. The env is set before vitest pool spawns
workers, so every fork's setupFiles see MU_TMUX_SOCKET in its
allowlist correctly.

PART B — widen the sweep regex OR make it stricter the other way.

Option B1 (widen): kill any session whose name matches a hardcoded
test-name list (alpha, beta, demo, gamma, scratch, ws, ws2). This
is brittle — every new hardcoded test name needs a sweep update.

Option B2 (stricter — preferred): add a positive-allowlist to the
sweep. List every USER workstream we MUST NEVER kill (read from
the user's actual DB at sweep time):

    const userWorkstreams = await readUserWorkstreamsFromDb();
    const protected = new Set([
      ...userWorkstreams,
      "tui-impl",  // always protect the orchestrator's own ws
    ]);
    for (const session of allMuSessions) {
      const wsName = session.replace(/^mu-/, "");
      if (!protected.has(wsName)) {
        await tmux kill-session -t session;
      }
    }

This is "kill anything not on the allowlist" rather than "kill
anything matching a regex". Much safer in the long run.

Caveat: reading the user's DB requires the DB hard-guard from
round-2 to also tolerate read-only opens of the user DB (the
sweep is metadata-only, not a test trying to write). Either:
  - relax the guard for read-only opens
  - or have the sweep call `mu workstream list --json` as a child
    process, which uses the production code path (not under VITEST,
    so the hard-guard doesn't fire)

Option B2 + Part A together = bullet-proof.

PART C — RENAME THE LEGACY HARDCODED TESTS.

Long-term hygiene: the tests that hardcode `"alpha"`, `"demo"`,
`"ws"`, etc. should still call `freshWorkstream("alpha")` or
similar so they get unique names. Audit:

    rg -l '"alpha"|"beta"|"demo"|"gamma"|"scratch"|"ws"' test/

15+ test files use hardcoded short names. These work fine in
unit-test mode (no real tmux side effects) but in any
real-tmux integration test they leak. Convert to
`freshWorkstream("foo")`. Effort proportional — a search/replace
pass.

CONSTRAINTS
-----------
- 1500 LOC hard cap per file.
- Conventional commit prefix: test:
- Four greens before commit.
- Ship as 2 commits:
    Commit 1: test: propagate MU_TMUX_SOCKET to forks at module
              load (was set in setup() too late) + verify
    Commit 2: test: allowlist-based default-socket sweep (kill
              anything not in user's DB) — protects user
              workstreams, kills anything else

DOCS
----
- AGENTS.md "Tests" section: clarify the env-propagation order
  and the allowlist-sweep philosophy.
- CHANGELOG.md (under v0.4.0): bullet under "Test infrastructure".

VERIFY
------
1. Hypothesis check (before any fix):
     Add the console.error("[mu-test fork] MU_TMUX_SOCKET=", ...)
     to test/_setup.ts. Run `npm test` and confirm the value is
     undefined for every fork. (If it's already set: Part A is
     not needed; the leak is from somewhere else and the regex
     widen of Part B is the only fix.)

2. Part A applied:
     Re-run `npm test`. Confirm:
       - tmux -L $TEST_SOCKET ls    → has the test sessions
       - tmux ls                     → no new mu-* residue
     Cleanup leaves both empty after teardown.

3. Part B applied:
     Pre-populate the default socket with `mu-someother` (a
     plausible user session). Run the suite. Verify:
       - mu-someother → still alive (allowlist protected it)
       - any test-residue → killed

OUT OF SCOPE
------------
- Don't touch the 'feedback' workstream (user-confirmed real).
- Don't remove the legacy hardcoded-name tests; just add the
  freshWorkstream wrapper around them (Part C is a renaming
  pass, not a test rewrite).
- Don't add a "panic kill all mu-* sessions" mode — that would
  nuke the user's real workstreams.

⚠️ FINAL ACTION ⚠️
After committing both layers, run from the workspace dir:
    mu task close bug_test_flake_round_3 -w tui-impl --evidence "<sha1> + <sha2>"
```

### #2 by "worker-2", 2026-05-11T18:51:05.517Z

```
CLOSE: 88601d7 (Part A: env at module load) + cd6adad (Part B: allowlist sweep). 4 greens both commits. Verified pre-existing mu-alpha protected, mid-suite mu-injected-leak killed at teardown.
```
