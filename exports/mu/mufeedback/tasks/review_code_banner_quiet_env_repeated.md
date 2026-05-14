---
id: "review_code_banner_quiet_env_repeated"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.1
roi: 350.00
owner: null
created_at: "2026-05-09T08:33:26.827Z"
updated_at: "2026-05-09T09:23:27.457Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: MU_BANNER_QUIET branch + window-border apply duplicated 3× across spawn/init/adopt

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-09T08:33:46.856Z

```
FILES: src/agents/spawn.ts:208-213, src/cli/agents.ts:397-401 (cmdAdopt), src/cli/workstream.ts:58-62 (cmdInit)

FINDINGS: Three near-identical blocks for "if MU_BANNER_QUIET isn't set, look up the window for the pane and call enableMuPaneBorders":

  // spawn.ts:208-213
  if (process.env.MU_BANNER_QUIET !== "1") {
    const wid = await getWindowIdForPane(paneId).catch(() => undefined);
    if (wid) await enableMuPaneBorders(wid).catch(() => {});
  }

  // cli/agents.ts:397-401 (cmdAdopt)
  if (process.env.MU_BANNER_QUIET !== "1") {
    const wid = await getWindowIdForPane(paneId).catch(() => undefined);
    if (wid) await enableMuPaneBorders(wid).catch(() => {});
  }

  // cli/workstream.ts:58-62 (different shape; calls enableMuPaneBordersForSession instead, but same env guard)
  if (process.env.MU_BANNER_QUIET !== "1") {
    await enableMuPaneBordersForSession(sessionName).catch(() => {});
  }

The first two are byte-equivalent; the third is the "init" variant. The env-var check is the same; the action is one of two helpers. Two issues:

1. Three independent reads of process.env.MU_BANNER_QUIET — and three independent decisions to defang the helper to "best-effort silent". Future change to either env-var name or the silence policy needs to find all three.
2. The helpers themselves (enableMuPaneBorders, enableMuPaneBordersForSession) DON'T self-check the env var. So a future caller who copies one of the .catch(() => {}) idioms but forgets the env guard will set the border even when the operator wants quiet.

WHY IT MATTERS: 35. Code-smell + future-bug surface. Pure copy-paste; the helpers should encapsulate their own opt-out so the caller isn't responsible.

SUGGESTED FIX (~15 LOC):
1. Move the MU_BANNER_QUIET check INTO enableMuPaneBorders and enableMuPaneBordersForSession in src/tmux.ts. Both become no-ops when the env var is set.
2. Replace the three caller sites with a direct call (no env wrapping).
3. Optionally: add a small helper `enableMuPaneBordersForPane(paneId)` that wraps the getWindowIdForPane → enableMuPaneBorders sequence, since that two-step is exactly what spawn.ts and cmdAdopt repeat.

Caller becomes one line:
  await enableMuPaneBordersForPane(paneId);  // self-checks MU_BANNER_QUIET; best-effort

ALTERNATIVES CONSIDERED:
- Leave the env check at the call site (current shape) and just dedupe the getWindowIdForPane → enableMuPaneBorders pair into a helper. Smaller; doesn't address the "future caller forgets the env guard" risk.
- Make MU_BANNER_QUIET into a hot-loaded boolean global at process start (`const BANNER_QUIET = process.env.MU_BANNER_QUIET === "1"`). Doesn't reduce duplication; just renames it.

EVIDENCE: 4 grep hits for MU_BANNER_QUIET across src/; three are env-checks at call sites, the fourth is the comment in cli/workstream.ts:57 explaining the opt-out.
```
