// Pure formatters shared across the TUI cards/popups cluster.
//
// Hoisted out of cards/* and popups/* in a single bundled pass per:
//   - review_dedup_age_ms             (4 consumers)
//   - review_dedup_color_for_bucket   (3 byte-identical copies)
//   - review_dedup_format_roi         (3 callsites + 2 inline dups)
//   - review_unify_format_when_since  (formatSinceClaim / formatWhen
//                                      → relTime / relTimeAgo)
//
// Every helper here is pure (input → output, no I/O, no ink/react),
// covered directly by test/tui-format-helpers.test.ts. Card / popup
// modules import from here instead of carrying their own copies.
//
// New helpers belong here only when ≥2 cards/popups need them; one-
// off card-local helpers stay co-located with their card. Keep this
// module ink/react-free so it can be imported from anywhere.

import type { RoiBucket } from "../../state.js";
import type { TaskRow } from "../../tasks.js";
import { relTime, relTimeAgo } from "../format.js";

/** Milliseconds since the task last had a lifecycle flip. Returns
 *  null when updatedAt is unparseable (defensive — every row from
 *  SQLite will be a valid ISO-8601 string). The basis is `now` so
 *  tests can pin time without leaning on the wall clock.
 *
 *  Used by: cards/inprogress, cards/recent, popups/inprogress,
 *  popups/recent. */
export function ageMs(t: TaskRow, now: number): number | null {
  const ts = Date.parse(t.updatedAt);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, now - ts);
}

/** Ink colour for an ROI bucket: high|infinite → green, mid →
 *  yellow, low → undefined (no colour, default text colour). Pure;
 *  consumers pass the result straight to a `<Text color=...>`.
 *
 *  Used by: cards/ready, cards/blocked, popups/blocked. */
export function colorForBucket(b: RoiBucket): string | undefined {
  switch (b) {
    case "high":
    case "infinite":
      return "green";
    case "mid":
      return "yellow";
    case "low":
      return undefined;
  }
}

/** Render the ROI cell as a short integer, or "∞" when effortDays is
 *  zero / negative (matches the convention used by every blocked /
 *  ready / in-progress / recent card and popup). Pure.
 *
 *  Used by: cards/blocked, cards/ready, popups/blocked,
 *  popups/inprogress, popups/recent. */
export function formatRoi(impact: number, effortDays: number): string {
  if (effortDays <= 0) return "∞";
  const r = Math.round(impact / effortDays);
  return Number.isFinite(r) ? String(r) : "∞";
}

/** Render an in-flight age in milliseconds as a short relative-time
 *  token (no suffix):
 *    < 60s   → "Ns"
 *    < 60m   → "Nm"
 *    < 24h   → "Nh"
 *    < 7d    → "Nd"
 *    else    → "Nw"
 *  null / undefined → "—". Thin wrapper over relTime() so the TUI
 *  cluster shares the canonical formatter. The "—" sentinel is the
 *  only TUI-specific bit (CLI tables render "—" themselves at the
 *  call site).
 *
 *  Used by: cards/inprogress, popups/inprogress. */
export function formatSinceClaim(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return relTime(ms);
}

/** Render a closed-at age in milliseconds as a short relative-time
 *  token with the trailing " ago" suffix:
 *    < 60s   → "Ns ago"
 *    < 60m   → "Nm ago"
 *    < 24h   → "Nh ago"
 *    < 7d    → "Nd ago"
 *    else    → "Nw ago"
 *  null / undefined → "—". The " ago" suffix is the differentiator
 *  vs formatSinceClaim (in-flight, present tense); here every row
 *  is past tense.
 *
 *  Used by: cards/recent, popups/recent. */
export function formatWhen(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return relTimeAgo(ms);
}
