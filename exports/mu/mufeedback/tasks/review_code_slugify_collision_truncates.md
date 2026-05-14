---
id: "review_code_slugify_collision_truncates"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: null
created_at: "2026-05-08T11:32:33.441Z"
updated_at: "2026-05-08T13:22:45.942Z"
blocked_by: []
blocks: []
---

# BUG: idFromTitle's collision suffix can truncate the suffix itself, causing infinite collision loop

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-08T11:32:33.559Z

```
FILES:
  src/tasks.ts:200-210 (idFromTitle)
  src/tasks.ts:151-188 (slugifyTitle, SLUG_SOFT_CAP=40, SLUG_HARD_CAP=64)

FINDINGS: idFromTitle's collision-suffix loop computes:

  const candidate = `${base}_${i}`.slice(0, SLUG_HARD_CAP);

Pathological case: a title that yields a base slug whose length is exactly SLUG_HARD_CAP (64 chars; reachable only via the `t_` / `mu_` prefix paths since SOFT_CAP is 40, but theoretically possible). Then for every i, the slice(0, 64) chops off the entire `_i` suffix, leaving `candidate === base` — loop hits 1000 iterations and throws ("could not derive a unique id from title in workstream ...").

More realistic case: when `i >= 100`, `_100` is 4 chars; if base.length is 60, candidate = base.slice(0, 60) = base unchanged. Loop wastes 900 iterations even though, in principle, a shorter base + `_100` suffix could still fit and be unique.

In normal operation (base ≤ 40 from SOFT_CAP) this is fine because base + `_999` = 44 chars. So the bug is latent until someone constructs a deeply-nested-prefix title. But since slugifyTitle hand-injects `t_` and re-injects `t_` again on the mu_-prefix path, you can construct a base that's exactly t_t_<long-thing>...

WHY IT MATTERS: latent bug — won't bite a random user, but the moment someone hits the collision-loop on a long-titled task they get an inscrutable error ("could not derive a unique id from title..."). The fix is structural; the right place to truncate is the BASE before adding the suffix.

SUGGESTED FIX (~5 LOC): truncate base to leave room for the suffix:

  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const truncatedBase = base.slice(0, SLUG_HARD_CAP - suffix.length);
    const candidate = `${truncatedBase}${suffix}`;
    if (getTask(db, candidate) === undefined) return candidate;
  }

Now `_2` through `_999` are guaranteed to actually differ from base.

ALTERNATIVES CONSIDERED:
  - "raise SLUG_HARD_CAP": doesn't fix the structural problem.
  - "limit base in slugifyTitle to SLUG_HARD_CAP - 4": couples slugify to collision-loop knowledge; worse.

EVIDENCE: src/tasks.ts:209 slice happens AFTER concat. Reproduction: hand-craft a title that produces a 64-char slug (e.g. via stretching the prefix path) and try to addTask twice. Test gap: test/tasks.test.ts presumably covers slug derivation but probably not the slug-at-hard-cap-collision path.
```
