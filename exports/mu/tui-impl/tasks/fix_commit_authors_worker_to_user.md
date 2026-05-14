---
id: "fix_commit_authors_worker_to_user"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-13T16:35:52.784Z"
updated_at: "2026-05-13T16:39:31.779Z"
blocked_by: []
blocks: []
---

# CHORE: rewrite worker-* commit authors to Martin Trojer for the last 100+ commits

## Notes (2)

### #1 by "π - mu", 2026-05-13T16:35:53.859Z

```
TASK: fix_commit_authors_worker_to_user — rewrite git history so
worker-N <worker-N@mu> commits are reattributed to the human
operator (Martin Trojer <mtrojer@meta.com>).

WHY
The mu workflow spawns each worker pi-agent in its own git
worktree under ~/.local/state/mu/workspaces/<ws>/<worker>/, which
defaults to a per-worker identity (worker-3 / worker-3@mu, etc.).
Cherry-picks land those commits onto main with the per-worker
identity preserved. The commits are FUNCTIONALLY mine — the
operator approved every plan and cherry-picked every change — so
the visible author should match the human-on-record.

EXECUTED BY ORCHESTRATOR (per user instruction "you have to do
this task yourself").

PLAN

1. git log audit: count worker-N commits and confirm the target
   range.

       git log --format='%an %ae' | sort | uniq -c | sort -rn

2. Use a mailmap during a one-shot history rewrite (git
   filter-repo with --use-mailmap, or git filter-branch with an
   --env-filter, depending on which is installed).

       cat > /tmp/mailmap <<MAP
       Martin Trojer <mtrojer@meta.com> <worker-1@mu>
       Martin Trojer <mtrojer@meta.com> <worker-2@mu>
       Martin Trojer <mtrojer@meta.com> <worker-3@mu>
       Martin Trojer <mtrojer@meta.com> <worker-4@mu>
       Martin Trojer <mtrojer@meta.com> <mu@local>
       Martin Trojer <mtrojer@meta.com> <mu-bot@mu.local>
       Martin Trojer <mtrojer@meta.com> <worker-mf-1@mu.local>
       Martin Trojer <mtrojer@meta.com> <worker-mf-2@mu>
       Martin Trojer <mtrojer@meta.com> <worker-mf-3@mu>
       Martin Trojer <mtrojer@meta.com> <worker-notestail-1@mu>
       MAP

       git filter-repo --use-mailmap --force --mailmap /tmp/mailmap

   git filter-repo strips the remote on success — re-add it after.

3. Verify: git log --format='%an %ae' | sort -u — should show
   only "Martin Trojer mtrojer@meta.com".

4. Force-with-lease push to origin (safe because we own the
   branch).

5. Make sure WORKER WORKSPACES are still on a sane state. If
   their HEADs were rewritten in our local clone, that's fine —
   their workspaces are git worktrees of THIS repo, so the SHAs
   they hold are the OLD pre-rewrite ones. They'll be obsolete
   anyway because workspaces get recreated from main between
   waves. A future `mu workspace recreate` will fast-forward
   them to the new HEAD.

VERIFICATION
- `git log --format='%an %ae' -100 | sort -u` → single line
  "Martin Trojer mtrojer@meta.com".
- `git push --force-with-lease origin main` succeeds.
- `mu doctor` still green.
- Build smoke: `node dist/cli.js --help` clean.

⚠️ FINAL ACTION
After verification:

  mu task close fix_commit_authors_worker_to_user -w tui-impl \
    --evidence "<sha-range>: rewrote N commits to Martin Trojer <mtrojer@meta.com> via git filter-repo --use-mailmap; force-pushed; verified author uniqueness"
```

### #2 by "π - mu", 2026-05-13T16:39:31.779Z

```
CLOSE: f02e017: rewrote 465 commits via git filter-repo --mailmap; consolidated 10 distinct worker-* / mu-bot identities into single Martin Trojer <martin.trojer@gmail.com>; force-with-leased to origin/main; typecheck + lint + test:fast + build all green; bundle smoke clean
```
