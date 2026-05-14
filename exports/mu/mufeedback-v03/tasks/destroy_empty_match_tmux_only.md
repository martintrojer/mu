---
id: "destroy_empty_match_tmux_only"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.15
roi: 200.00
owner: null
created_at: "2026-05-10T07:32:33.313Z"
updated_at: "2026-05-10T07:51:45.189Z"
blocked_by: []
blocks: []
---

# fix: mu workstream destroy --empty should match tmux-only sessions (no DB row); also DB-empty + alive-tmux already works

## Notes (2)

### #1 by "π - mu", 2026-05-10T07:33:11.760Z

```
fix: mu workstream destroy --empty should also match tmux-only sessions.

═══ THE FRICTION (op screenshot at pause time) ═══

Live state:
  tmux list-sessions ⇒ mu-alpha, mu-beta, mu-empty, mu-gamma, mu-scratch, mu-ws (6 mu-prefix sessions)
  workstreams table  ⇒ only mufeedback-v03 + roadmap-v0-3 (2 registered)

  mu workstream destroy --empty
  ⇒ "no empty workstreams found"

Operator expectation: --empty should also clean those 6 stale `mu-*` tmux sessions. Today's predicate is restricted to REGISTERED rows.

═══ ROOT CAUSE ═══

src/workstream.ts listEmptyWorkstreams (the SDK behind --empty) starts FROM workstreams (the DB table) and LEFT-JOINs the child tables. By construction it can't surface a workstream that has no row in workstreams — i.e., a tmux-only session that mu never ran `workstream init` against (or that survived a destroy that nuked the DB row but not the tmux session, or was created out-of-band).

Operator's stated rule (the nit): "destroy empty should still match workstreams with an active tmux session (but nothing else)". Two cases:
  CASE A (already works post-shipping): registered ws, zero tasks/agents/workspaces/approvals, with a live tmux session ⇒ matched + destroyed by --empty.
  CASE B (the gap): UNregistered tmux session with mu- prefix, no DB row at all ⇒ NOT matched today.

Tested CASE A: spawn 'mu workstream init foo' (no tasks); 'mu workstream destroy --empty' includes 'foo'. ✓
CASE B is the actual fix.

═══ THE FIX ═══

Extend listEmptyWorkstreams to ALSO surface tmux-only `mu-*` sessions:

  export async function listEmptyWorkstreams(db: Db): Promise<WorkstreamSummary[]> {
    // Existing: registered workstreams with no child rows.
    const registeredEmpty = ...today's query...

    // NEW: tmux sessions of the form `mu-*` whose name doesn't appear
    // in the workstreams table.
    const tmuxNames = new Set<string>();
    for (const session of await listSessions()) {
      if (session.name.startsWith("mu-")) tmuxNames.add(session.name.slice(3));
    }
    const dbNames = new Set<string>(
      (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map(r => r.name)
    );
    const tmuxOnly = [...tmuxNames].filter(n => !dbNames.has(n)).sort();

    // Compose: union both. tmux-only entries get a synthetic
    // WorkstreamSummary (registered=false; counts all 0; tmuxAlive=true).
    const tmuxOnlySummaries = await Promise.all(
      tmuxOnly.map(name => summarizeWorkstream(db, { workstream: name }))
    );

    // sort union by name; remove dups (a registered-empty with the same
    // name is never tmux-only by construction, but be defensive).
    const all = [...registeredEmpty, ...tmuxOnlySummaries];
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

═══ DESTROY PATH HANDLES BOTH CASES ALREADY ═══

destroyWorkstream() in src/workstream.ts already handles a non-existent DB row gracefully (the DELETE FROM workstreams WHERE name=? sets changes=0 but the tmux killSession still runs). So the --yes loop in cmdDestroyEmpty needs no change.

Verify by spot-test: a tmux-only session destroyed by --empty --yes ⇒ killedTmux=true, deletedAgents=0, deletedTasks=0 (correctly).

═══ DRY-RUN OUTPUT ═══

The dry-run table today shows: workstream | created_at | tmux. For tmux-only entries:
  - workstream: bare name (already done; the prefix-stripping happens at sniff time).
  - created_at: empty string (workstreamCreatedAt() already returns "" for unregistered names; that's load-bearing for this case). Render as pc.dim('—') instead of empty for prettiness.
  - tmux: alive (always; that's the only signal that surfaced them).

═══ TESTS ═══

Extend test/workstream-destroy-empty.test.ts (NEW file from the recent --empty PR):
  - Seed two mu-* tmux sessions WITHOUT DB rows (use the existing test helper that creates a tmux session directly).
  - --empty (dry-run): both tmux-only entries appear; created_at column renders as '—'.
  - --empty --yes: both tmux sessions are killed; no DB rows created or deleted (they didn't exist).
  - Mixed: 1 registered-empty + 1 tmux-only ⇒ both destroyed.
  - tmux session WITHOUT mu- prefix (e.g., 'plain-session'): NOT matched. Crucial — we don't kill operator's unrelated tmux sessions.

═══ DOCS ═══

Extend docs/USAGE_GUIDE.md --empty paragraph: "Also surfaces unregistered mu-* tmux sessions (typically test litter or remnants from a partial destroy). The matching predicate is narrow on purpose — only `mu-*` sessions with no DB row; arbitrary tmux sessions are never touched."

CHANGELOG.md (v0.3 unreleased): one-line "destroy --empty now also surfaces unregistered mu-* tmux sessions (test litter / partial-destroy remnants)".

═══ ANTI-FEATURES ═══

  - DON'T match tmux sessions WITHOUT the mu- prefix. mu only owns mu-* sessions; matching others would be data loss.
  - DON'T add a separate flag for tmux-only matching (e.g., --include-tmux-only). The semantic is "empty workstream"; the prefix is the namespace.
  - DON'T promote tmux-only entries to registered workstreams as a side-effect ("auto-adopt"). They have no DB context worth preserving; just kill them.

═══ SCOPE ═══

  src/workstream.ts: ~25 LOC — extend listEmptyWorkstreams.
  src/cli/workstream.ts: maybe ~5 LOC — render '—' instead of '' in the created_at cell when empty.
  test/workstream-destroy-empty.test.ts: ~80 LOC of new cases.
  docs + CHANGELOG: ~5 lines.

Total ~120 LOC.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close destroy_empty_match_tmux_only -w mufeedback-v03 --evidence 'tmux-only sessions matched; tests + docs'
```

### #2 by "reaper", 2026-05-10T07:45:50.969Z

```
[reaper] previous owner worker-3 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```
