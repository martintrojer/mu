---
id: "review_code_status_emoji_two_sources"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-08T11:28:52.964Z"
updated_at: "2026-05-08T11:46:39.033Z"
blocked_by: []
blocks: []
---

# REVIEW: STATUS_EMOJI vs statusIcon: two sources of truth, already drifted

## Notes (1)

### #1 by code-reviewer-1, 2026-05-08T11:29:12.292Z

```
FILES:
  src/agents.ts:201-209 (STATUS_EMOJI)
  src/cli.ts:297-313 (statusIcon)

FINDINGS: a974775 added STATUS_EMOJI in src/agents.ts so composeAgentTitle can render the same status glyphs that the CLI's statusIcon already prints. The two maps have ALREADY DRIFTED:

  STATUS_EMOJI.needs_permission = "🛂"   (passport control)
  statusIcon(needs_permission)  = "🔐"   (lock)

  STATUS_EMOJI.free             = "✅"   (white check mark)
  statusIcon(free)              = "✓"   (heavy check)

The agents.ts comment even acknowledges it: "Mirrors statusIcon in cli.ts but without picocolors". A "mirror" that already disagrees on 2 of 7 statuses is not a mirror — it's two sources of truth competing for the operator's attention. The pane border (composeAgentTitle) uses one glyph; `mu agent list` / `mu state` table uses another for the same status. An operator looking at both at once gets a "do these mean the same thing?" question they shouldn't have to ask.

WHY IT MATTERS: maintainability hazard that's already producing a UX bug. Adding/renaming a status now means hunting two places (and the dogfood will keep silently de-syncing them). Not a correctness bug, but the inconsistency erodes trust ("which one is the real status?").

SUGGESTED FIX (~15 LOC): make statusIcon a thin wrapper over STATUS_EMOJI plus a colour map. Replace the case statement with:

  const STATUS_COLORS: Record<AgentStatus, (s: string) => string> = {
    spawning: pc.yellow, busy: pc.cyan, needs_input: pc.dim,
    needs_permission: pc.magenta, free: pc.green,
    unreachable: pc.red, terminated: pc.dim,
  };
  function statusIcon(s: AgentStatus): string { return STATUS_COLORS[s](STATUS_EMOJI[s]); }

Then drop one of the duplicate emoji maps. Pick whichever glyph set looks better in the pane border (titles only render plain text — no ANSI — so STATUS_EMOJI's choices win by default).

ALTERNATIVES CONSIDERED:
  - "leave it, they look similar enough": no, "🛂" vs "🔐" is materially different in semantics; check vs heavy-check is a cosmetic mismatch but the lock vs passport one is real.
  - "keep them separate but add a sync test": adds testing burden for what should be a one-source-of-truth.

EVIDENCE: git blame src/agents.ts STATUS_EMOJI and grep "🔐\|🛂\|✅\|✓" — the exact same code that comments "Mirrors statusIcon" disagrees on 2/7 entries. No test covers the assertion that they match.
```
