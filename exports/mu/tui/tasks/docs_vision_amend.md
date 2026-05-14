---
id: "docs_vision_amend"
workstream: "tui"
status: CLOSED
impact: 80
effort_days: 0.5
roi: 160.00
owner: "designer-2"
created_at: "2026-05-11T10:45:23.647Z"
updated_at: "2026-05-11T10:55:11.095Z"
blocked_by: ["design_locked"]
blocks: ["design_complete", "docs_changelog"]
---

# Draft VISION.md amendment: short-lived-process pillar gets TUI exception

## Notes (2)

### #1 by "designer-2", 2026-05-11T10:55:07.898Z

```
FILES:
- docs/VISION.md (read in full; lines 332-356 are the "Key Constraints" section, target for amendment)
- docs/ROADMAP.md (anti-feature pledges around line 47-79)
- AGENTS.md ("Every invocation is short-lived" appears in DON'Ts at line 296)
- mu task notes design_locked -w tui (locked decisions)

COMMANDS:
- grep -n -i "short-lived|daemon|invocation|polling" docs/VISION.md docs/ROADMAP.md AGENTS.md
  → confirmed VISION.md does NOT state the "every invocation is short-lived"
    pillar explicitly. The closest existing text is Constraint #6
    ("Subscriptions are polling-based ... without a daemon") and the
    "Not a hosted service" line in "What It Is NOT". The pledge IS
    explicit in ROADMAP.md ("Add a daemon, watcher, or background
    process beyond what tmux / SQLite give us") and in AGENTS.md DON'Ts.

FINDINGS:
1. The pillar being amended is CURRENTLY IMPLICIT in VISION.md. We are
   simultaneously (a) naming it for the first time in the canonical doc
   and (b) carving the TUI exception. This is honest scope creep — but
   small, and the brief explicitly calls for "explicit, narrowly-scoped
   exception", which presupposes the pillar is named.

2. `mu log --tail` is ALREADY a long-lived interactive reader inside one
   invocation: it polls SQLite once/sec until SIGINT. Constraint #6
   already implicitly permits this shape. So the TUI is not a brand-new
   exception class — it's a second member of the same class. Framing the
   amendment that way (rather than as a one-off carve-out) is more honest
   AND tighter, because it exposes the predicate that bounds both:
   interactive + read-only + dies with the user + no resources beyond
   stdio + a poll timer.

3. Mutations from the TUI flow through `yank → quit → fresh mu <verb>`
   per locked decision R1 ("model drives the CLI; act-intents YANK
   mu commands, never execute"). This means the "every state mutation is
   a fresh short-lived typed verb" property is preserved unchanged. The
   exception is purely about the long-lived READER, not about how writes
   land.

4. The TTY gate (`process.stdout.isTTY`) plus the `--json` fallback (per
   locked scope: "Static `mu state` (without --hud) remains the non-TTY
   fallback") together ensure scripts/CI/pipes ALL keep the
   short-lived-CLI shape they rely on. The exception only activates for
   genuine interactive humans.

DECISION:
Amend VISION.md by REPLACING Constraint #6 with a generalised version
that names the short-lived-process pillar and lists the two interactive
readers (existing `mu log --tail`, new TUI) as the only members of the
exception class, gated by four shared properties.

----- BEFORE (docs/VISION.md, Key Constraints, item #6 around L351-355) -----

6. **Subscriptions are polling-based.** `mu log --tail` polls
   SQLite once per second. SQLite handles the concurrency; latency
   is bounded by the poll interval. Real subscription mechanisms
   (SQLite hooks, fs.watch) are a future ask if anyone hits the
   latency cliff.

----- AFTER -----

6. **Subscriptions are polling-based.** `mu log --tail` polls
   SQLite once per second. SQLite handles the concurrency; latency
   is bounded by the poll interval. Real subscription mechanisms
   (SQLite hooks, fs.watch) are a future ask if anyone hits the
   latency cliff.

7. **Every invocation is short-lived — except for two named
   interactive readers.** mu is a CLI: each verb starts, mutates
   or reads, prints, and exits. There is no daemon, no resident
   state outside SQLite, no background process. Two verbs are
   deliberately and narrowly exempt because they are interactive
   *readers*, not background workers:

   - `mu log --tail` — polls SQLite once per second; emits NDJSON
     until SIGINT or the parent closes stdin.
   - `mu` / `mu state` in interactive TUI mode — renders a
     dashboard until the user quits.

   Both share the same shape, and the shape is the predicate that
   bounds the exception:

   - **Interactive, not a daemon.** The process is owned by a
     human (or a parent script) and dies the moment that owner
     ends it. Nothing keeps it alive across sessions; nothing
     restarts it.
   - **Read-only against SQLite.** Neither verb writes. The TUI's
     act-intents (claim, close, send, ...) yank the canonical
     `mu <verb>` command into the clipboard and exit the
     dashboard; every mutation still lands through a fresh
     short-lived CLI invocation.
   - **No resources beyond stdout, stdin, and a poll timer.** No
     sockets, no file watches, no subscriptions to external
     services, no spawned subprocesses, no inter-process state
     beyond the SQLite reads any other CLI invocation already
     does.
   - **TTY-gated, with a static fallback.** The TUI mode only
     activates when `process.stdout.isTTY` is true and `--json`
     is absent. Non-TTY callers (pipes, CI, sub-shells) and any
     `--json` caller get the static `mu state` card instead, so
     every scripted use of mu keeps the short-lived-CLI shape it
     relies on.

   This is not a precedent for any other long-lived process. The
   anti-feature pledges in [ROADMAP.md](ROADMAP.md) ("no daemon,
   watcher, or background process beyond what tmux / SQLite give
   us") remain in force; a third member of this exception class
   would need its own promotion.

----- END AFTER -----

JUSTIFICATION (for commit message):

> Name the "every invocation is short-lived" pillar explicitly in
> VISION.md and carve a single bounded exception for the interactive
> `mu` / `mu state` TUI mode. The pillar was previously implicit
> (Constraint #6's "without a daemon" wording, ROADMAP's no-daemon
> pledge, AGENTS.md's DON'Ts); the TUI work makes it load-bearing
> enough to deserve a name. The exception is bounded by four
> properties (interactive, read-only, no extra resources, TTY-gated
> with static fallback) that `mu log --tail` already satisfies, so
> the carve-out is one new member of an existing class — not a new
> class. Mutations still flow through fresh short-lived CLI verbs
> via the TUI's yank-and-exit flow, so the "every state mutation is
> a typed verb starting from cold" property survives. ROADMAP's
> separate "no render layer beyond cli-table3 + picocolors" pledge
> is amended in a sibling task (docs_roadmap_amend); this commit
> does not touch ROADMAP.md.

SECOND-ORDER PILLAR IMPLICATIONS reviewers will flag:

1. "Does this open the door to other long-lived processes?"
   Answer baked into the amendment: NO. The four-property predicate
   (interactive + read-only + no extra resources + TTY-gated) is
   stated as the BOUND, and the closing sentence explicitly says a
   third member would need its own promotion. The ROADMAP anti-
   feature pledge is referenced rather than weakened.

2. "The TUI polls every 1s — doesn't that contradict pillar 7's
   'mu cold-start cost is sidestepped because we're not in tight
   loops'?"
   No: that pillar argues against operators repeatedly INVOKING mu
   in tight loops (which would pay V8 init each time). The TUI
   pays V8 init ONCE per session and polls within one warm process.
   It's the same shape as `mu log --tail`, which the cold-start
   argument already permits. Worth a one-line note in the commit
   if a reviewer raises it, but the existing pillar 7 text doesn't
   need editing.

3. "Won't someone want `mu agent show --watch`, `mu task tree
   --watch`, etc. next?"
   Plausible. The amendment's last paragraph blocks that path: a
   third long-lived reader must clear promotion. The dashboard
   subsumes the per-resource watch use case (Shift+1-9 fullscreen
   popups per locked design) so the pressure is reduced rather than
   amplified.

4. "Constraint #6 and #7 overlap — why two items?"
   Considered collapsing into one. Kept separate because #6 is
   about the polling MECHANISM (why latency is 1s) and #7 is about
   the process LIFECYCLE pillar (why we have no daemon). They are
   different invariants that happen to share `mu log --tail` as an
   example.

5. "Read-only invariant — is it enforced or just stated?"
   Stated in VISION; enforcement is the implementation's job
   (locked decision R1: model drives the CLI; act-intents yank, not
   execute). If a future TUI feature wants to write directly,
   landing it would require amending VISION first — which is the
   right friction.

NEXT:
- docs_roadmap_amend (sibling task) handles the "no render layer beyond
  cli-table3 + picocolors" → "+ ink for TUI" pledge edit. Out of scope here.
- design_complete (downstream) consumes this note + the roadmap-amend note
  + the design_locked decisions to assemble the final design doc.
- The actual file edit to docs/VISION.md happens in a later task (this is
  a draft-only role per the scope guards).

VERIFIED:
- Draft text re-read against locked decisions: covers (a) interactive not
  daemon, (b) read-only, (c) no external services / stdout+stdin+poll-timer
  only, (d) non-TTY + --json fallback. All four bullets from the brief hit.
- Cross-checked anti-feature pledges in ROADMAP.md L47-79: amendment text
  references and reinforces them, does not weaken them.
- No edit to docs/VISION.md was made (scope guard: read-only role).

ODDITIES:
- VISION.md does not currently STATE the "every invocation is short-lived"
  pillar explicitly. The amendment names it for the first time in the
  canonical doc. Reviewer may push back ("we're inventing a pillar to
  amend it"); counter is in JUSTIFICATION above (the pledge already exists
  in ROADMAP.md and AGENTS.md, this just makes it legible where the rest
  of the load-bearing pillars live).
- Numbering: VISION.md "Key Constraints" currently runs 1-6. The
  amendment adds #7 rather than renumbering anything, so existing
  cross-references (none observed in repo) stay valid.
- The amendment contains a forward reference to ROADMAP.md (which is
  about to be amended in docs_roadmap_amend). The reference is to the
  no-daemon pledge, which is unchanged by that sibling task, so no
  ordering hazard.
```

### #2 by "designer-2", 2026-05-11T10:55:11.095Z

```
CLOSE: amendment text drafted in note; ready to apply
```
