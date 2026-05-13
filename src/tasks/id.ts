// mu — task id validation and title slug helpers.

import type { Db } from "../db.js";
import { getTask } from "./queries.js";

/** Lowercase alpha first, then alnum / underscore / hyphen, ≤64 chars. */
const TASK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}

/**
 * Derive a task id from a free-form title.
 *
 *   "Build the auth module"      → "build_the_auth_module"
 *   "FILES: foo.ts (refactor)"   → "files_foo_ts_refactor"
 */

/**
 * Soft cap for auto-generated slugs. The collision-suffix loop in
 * idFromTitle can push past this (`_2`, `_3`, ...) without going past
 * the hard ceiling. 40 chars hits the sweet spot of 'short enough to
 * type and to look reasonable in mu task tree' without losing too
 * much of the title's meaning.
 */
const SLUG_SOFT_CAP = 40;

/**
 * Hard ceiling for any generated id. Schema has no length limit, but
 * 64 keeps ids comfortable in tables, JSON, and tmux pane titles.
 */
const SLUG_HARD_CAP = 64;

/**
 * Lowercase title; collapse non-alnum runs into single `_`; trim
 * leading/trailing `_`; prefix `t_` if the result starts with a digit
 * (schema requires first char letter); apply the soft cap with
 * word-boundary trim (cut at the last `_` at-or-before SLUG_SOFT_CAP
 * when one exists, else hard-truncate). Mirrors `tg`'s `id_from_title`
 * but adds the soft cap.
 *
 * Throws if `title` yields an empty slug after stripping.
 */
export function slugifyTitle(title: string): string {
  return slugifyTitleVerbose(title).slug;
}

/**
 * Result of `slugifyTitleVerbose`: the slug plus enough metadata for
 * the CLI to decide whether to warn the user that meaning was lost.
 *
 *   slug           — the same string `slugifyTitle` returns.
 *   strippedLength — length of the post-strip pre-cap slug. When this
 *                    exceeds the SLUG_SOFT_CAP the verbose form had to
 *                    cut at a word boundary (or hard-truncate); the
 *                    cut clauses are gone with no in-band signal.
 *   originalSlug   — what the slug WOULD have been without the
 *                    SLUG_SOFT_CAP cut: full stripped slug with the
 *                    same `t_` digit-prefix correction and the same
 *                    SLUG_HARD_CAP ceiling, but no word-boundary
 *                    truncation. Equal to `slug` when nothing was
 *                    cut. The CLI surfaces this in `mu task add
 *                    --json` so scripted callers can detect the
 *                    truncation without grepping stderr.
 *   truncated      — true iff `slug.length < strippedLength` AFTER the
 *                    `t_` digit-prefix correction, i.e. real bytes were
 *                    dropped. False for any title that fits under the
 *                    soft cap or whose only diff vs the stripped slug
 *                    is the `t_` prefix.
 *
 * The CLI's `mu task add` uses `truncated` to print a one-line stderr
 * hint pointing at the `<id>` positional override and (under --json)
 * to surface `originalSlug` alongside `truncated:true`
 * (slugifytitle_silently_drops_clauses; task_add_slugify_silently_truncates_ids).
 */
export interface SlugifyResult {
  slug: string;
  strippedLength: number;
  originalSlug: string;
  truncated: boolean;
}

/**
 * Verbose sibling of `slugifyTitle`: returns the slug AND a
 * `truncated` flag so the CLI can hint to the user when the soft cap
 * dropped clauses (the meaning-shift hazard documented in
 * slugifytitle_silently_drops_clauses).
 *
 * Algorithm is byte-for-byte identical to `slugifyTitle`; this just
 * surfaces the metadata that the plain form throws away.
 */
export function slugifyTitleVerbose(title: string): SlugifyResult {
  const stripped = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (stripped.length === 0) {
    throw new Error(`title yields empty slug: ${JSON.stringify(title)}`);
  }
  // Soft cap with word-boundary preference: if the slug exceeds the
  // soft cap, look for the last `_` at-or-before the cap and cut there
  // (so we never break a word). If no underscore is in the cap window
  // (ie the title is one giant word), fall back to a hard truncate at
  // the soft cap. The result is always <= SLUG_SOFT_CAP after this.
  let trimmed: string;
  if (stripped.length <= SLUG_SOFT_CAP) {
    trimmed = stripped;
  } else {
    const window = stripped.slice(0, SLUG_SOFT_CAP);
    const lastSep = window.lastIndexOf("_");
    trimmed = lastSep > 0 ? window.slice(0, lastSep) : window;
  }
  // First char must be a letter → prefix `t_` if it isn't. v5 has no
  // global namespace and no reserved prefix; `mu_foo` is a perfectly
  // valid local_id (per-workstream unique).
  const applyPrefix = (s: string): string =>
    /^[a-z]/.test(s) ? s.slice(0, SLUG_HARD_CAP) : `t_${s}`.slice(0, SLUG_HARD_CAP);
  const slug = applyPrefix(trimmed);
  // `originalSlug` is what the slug would have been without the
  // soft-cap word-boundary cut: same prefix correction, same hard
  // cap, no word-boundary trim. Used by `mu task add --json` so
  // scripted callers can detect truncation programmatically.
  const originalSlug = applyPrefix(stripped);
  // `truncated` reflects whether real characters were dropped — the
  // `t_` prefix doesn't count as truncation. We compare the trimmed
  // length against the stripped length (both pre-prefix) so a digit-
  // led title that fit under the cap still reports truncated=false.
  return {
    slug,
    strippedLength: stripped.length,
    originalSlug,
    truncated: trimmed.length < stripped.length,
  };
}

/**
 * Generate a unique task id from a title. v5: tasks.local_id is
 * per-workstream unique, so the collision check scopes to one
 * workstream. On collision, appends `_2`, `_3`, … until unique.
 */
export function idFromTitle(db: Db, workstream: string, title: string): string {
  return idFromTitleVerbose(db, workstream, title).id;
}

/**
 * Result of `idFromTitleVerbose`: the unique-in-workstream id plus the
 * truncated flag from the underlying slugify pass. Used by `mu task
 * add` to decide whether to surface the stderr hint about lost clauses
 * (slugifytitle_silently_drops_clauses) and to surface the un-truncated
 * slug in `--json` (task_add_slugify_silently_truncates_ids).
 *
 *   id            — the unique-in-workstream task id.
 *   truncated     — true iff the underlying slugify pass cut real
 *                   characters (collision-suffixing does NOT flip
 *                   this).
 *   originalSlug  — what the slug would have been without the
 *                   SLUG_SOFT_CAP cut. Equal to `id` when nothing was
 *                   cut AND no collision suffix was appended; for
 *                   the truncation-detection use case the only thing
 *                   the CLI cares about is the lossy-vs-not
 *                   comparison surfaced via `truncated`.
 */
export interface IdFromTitleResult {
  id: string;
  truncated: boolean;
  originalSlug: string;
}

/**
 * Verbose sibling of `idFromTitle`: returns the unique id, the
 * `truncated` flag from the slugify pass, and the un-truncated
 * `originalSlug` for `--json` consumers. Collision-suffixing (`_2`,
 * `_3`, …) does not flip `truncated` — the underlying slug's lossiness
 * is what the CLI hint cares about.
 */
export function idFromTitleVerbose(db: Db, workstream: string, title: string): IdFromTitleResult {
  const { slug: base, truncated, originalSlug } = slugifyTitleVerbose(title);
  if (getTask(db, base, workstream) === undefined) return { id: base, truncated, originalSlug };
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`.slice(0, SLUG_HARD_CAP);
    if (getTask(db, candidate, workstream) === undefined)
      return { id: candidate, truncated, originalSlug };
  }
  throw new Error(`could not derive a unique id from title in workstream ${workstream}: ${title}`);
}

/**
 * Sanitise a free-form string into a candidate task id.
 *
 * Lowercases, replaces every non-`[a-z0-9_-]` char with `_`, trims any
 * leading non-letter (the schema requires the first char to be a
 * letter), truncates to 64 chars. Returns `"task"` when the input has
 * no usable letters at all so the suggestion in
 * `TaskIdInvalidError.errorNextSteps()` is always a runnable command.
 *
 * Mirrors `slugifyTitle`'s prefix corrections so suggested ids will
 * pass `isValidTaskId` if the user runs them verbatim. Lives next to
 * `slugifyTitle` rather than in `tasks/errors.ts` because it's a slug
 * helper, not an error helper — the only caller happens to be
 * `TaskIdInvalidError.errorNextSteps()`.
 */
export function sanitiseTaskId(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, SLUG_HARD_CAP);
  return s.length === 0 ? "task" : s;
}
