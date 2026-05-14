---
id: "bug_test_flake_round_4_self_heal"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-11T19:44:50.687Z"
updated_at: "2026-05-11T19:51:16.329Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: round-3 allowlist locks in test-residue as 'preexisting' on first run; need self-healing snapshot

## Notes (2)

### #1 by "π - mu", 2026-05-11T19:45:40.234Z

```
SYMPTOM
-------
After bug_test_flake_round_3 (Part B — allowlist sweep) landed,
testing showed:

  $ tmux ls | grep '^mu-' | grep -v real
  mu-alpha: 1 windows (created 19:58)
  mu-beta:  1 windows (created 19:56)
  mu-demo:  1 windows (created 19:56)
  ...

The 19:56-19:58 timestamps match the test-suite run that happened
DURING round-3's rollout, when Layer 3 hadn't fully propagated to
all forks yet. The sweep should have killed these on the next test
run, but didn't. Manual `tmux kill-session -t mu-alpha` was needed.

ROOT CAUSE
----------
test/_global-teardown.ts:175

    /** Snapshot of pre-existing `mu-*` default-socket sessions,
     *  captured once at module-load time. Frozen for the lifetime
     *  of the run. */
    const PROTECTED_PREEXISTING_SESSIONS: ReadonlySet<string> =
      await snapshotPreexistingSessions();

The allowlist's "preexisting sessions" snapshot is captured at
module load — i.e. at the start of EVERY test run. Whatever sessions
were on the user's default socket at that moment become PROTECTED
forever (for that run, and effectively forever because the next
run's snapshot inherits them via the same pattern).

So the round-3-rollout-window leaks (`mu-alpha` etc) got
"grandfathered in" as preexisting on the FIRST clean run after L3
landed, and now no future sweep will ever kill them. Sticky
contamination.

INTENT
------
The "preexisting" allowlist is meant to protect the user's REAL
ad-hoc tmux sessions — e.g. `mu-foo` they spun up by hand for an
experiment that doesn't have a DB row yet. That's a real use case.

But the heuristic over-applies when leftover test residue happens
to be on the socket at module-load.

FIX — three options
-------------------

OPTION A (simplest, recommended): replace "preexisting" with a
DB-backed allowlist ONLY. The user's REAL workstreams are exactly
the rows in `~/.local/state/mu/mu.db`'s `workstreams` table, plus
a fixed shortlist (orchestrator's own session, e.g. `mu-tui-impl`).
Anything else IS test residue. Drop the preexisting snapshot
entirely:

    function buildAllowlist(): ReadonlySet<string> {
      const dbWorkstreams = readUserWorkstreamsFromDb();
      // Map ws name → tmux session name
      const protectedSessions = new Set<string>();
      for (const ws of dbWorkstreams) protectedSessions.add(`mu-${ws}`);
      // ALWAYS protect the orchestrator's own session if any.
      const orchPane = process.env.MU_SESSION;
      if (orchPane) protectedSessions.add(`mu-${orchPane}`);
      return protectedSessions;
    }

Cost: an ad-hoc `tmux new-session -t mu-foo` (no DB row) gets killed
by the sweep. Solution: tell users to `mu workstream init foo` first,
which they'd need to do anyway to use it as a workstream.

OPTION B: snapshot preexisting sessions ONCE EVER (write the snapshot
to ~/.local/state/mu/test-allowlist.txt the first time it sees a new
session), but invalidate any entry that's also matching a known
TEST_FIXTURE_PREFIX or is older than N days. Heavier; option A is
simpler.

OPTION C: don't snapshot at all; instead sweep ONLY sessions that
match a known test-name pattern. This was the original Layer-2
approach, which round-3's allowlist replaced because regex was too
brittle. Going back is regression.

→ Recommend OPTION A.

LINE-PRECISE EDIT
-----------------
test/_global-teardown.ts:174-186

    -/** Snapshot of pre-existing `mu-*` default-socket sessions,
    - *  captured once at module-load time. Frozen for the lifetime
    - *  of the run. */
    -const PROTECTED_PREEXISTING_SESSIONS: ReadonlySet<string> =
    -  await snapshotPreexistingSessions();
    -
    -async function snapshotPreexistingSessions(): Promise<ReadonlySet<string>> {
    -  const ls = await execa("tmux", ["list-sessions", "-F", "#{session_name}"], {
    -    reject: false,
    -  });
    -  if (ls.exitCode !== 0) return new Set();
    -  return new Set((ls.stdout ?? "").split("
").filter((l) => l.length > 0 && l.startsWith("mu-")));
    -}

…and in buildAllowlist():

    const protectedSessions = new Set<string>();
    -for (const s of PROTECTED_PREEXISTING_SESSIONS) protectedSessions.add(s);
    for (const ws of readUserWorkstreamsFromDb()) protectedSessions.add(`mu-${ws}`);
    const orchSession = process.env.MU_SESSION;
    if (orchSession !== undefined) protectedSessions.add(`mu-${orchSession}`);

Also delete the helper + import. The diff should be ~30 LOC removal,
~5 LOC add.

VERIFY
------
1. Pre-fix:
     tmux ls | grep ^mu- | wc -l   # → many (residue + real)
2. Apply fix.
3. npm run test
4. tmux ls | grep ^mu- | grep -v <real-list>   # → empty

ONE-SHOT MANUAL CLEANUP
-----------------------
Before this fix lands, future test runs may continue to see the
already-leaked sessions. The orchestrator manually killed them with:

    for s in mu-alpha mu-beta mu-demo mu-gamma mu-scratch mu-ws mu-ws2; do
      tmux kill-session -t $s
    done

Document this in the commit body so the next dev knows.

CONSTRAINTS
-----------
- 1500 LOC hard cap per file.
- Conventional commit prefix: test:
- Four greens before commit.
- Suggested commit:
    test: allowlist drops "preexisting sessions" snapshot — DB-only
          (test residue can't grandfather itself in)

DOCS
----
- AGENTS.md "Tests" section: clarify the allowlist is DB-rooted
  only.
- CHANGELOG.md (under v0.4.0): bullet under "Test infrastructure".

OUT OF SCOPE
------------
- Don't change the layer-3 socket bootstrap (already correct).
- Don't add a config knob for the allowlist (no config file pledge).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_test_flake_round_4_self_heal -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-2", 2026-05-11T19:51:16.329Z

```
CLOSE: febf93b — DB-only allowlist; dropped snapshotPreexistingSessions + PROTECTED_PREEXISTING_SESSIONS; allowlist = mu-<row in workstreams> ∪ mu-$MU_SESSION. typecheck/lint/test (1611 passed)/build all green; tmux ls post-suite shows only real DB-rooted sessions (feedback/gchatui/infer-rs/tui-impl). Coverage in test/global-teardown-allowlist.test.ts (7 cases incl. new round-4 self-heal contract). AGENTS.md + CHANGELOG.md updated.
```
