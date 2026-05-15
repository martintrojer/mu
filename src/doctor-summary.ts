// Doctor summary — a TUI-friendly slice of `mu doctor`'s checks.
//
// The full `mu doctor` verb (src/cli/doctor.ts) renders a textual card
// with: tmux/env presence, DB schema integrity, schema_version,
// journal_mode, foreign_keys, per-workstream agent/task/log counts,
// and reconcile drift (would-be-pruned ghosts + orphan panes). The
// TUI's slot-9 Doctor card needs the same SIGNAL but at poll-tick
// cost: an array of checks the card can render row-by-row.
//
// Per feat_card_9_doctor (workstream `tui-impl`), promoted from the
// last reserved slot in design_global_keymap.
//
// CHEAPNESS RULES (so this is safe to run on every snapshot tick):
//   - Synchronous DB pragmas + COUNT(*)-shape SELECTs only.
//   - Reads `view.report.prunedGhosts` and `view.orphans` straight
//     out of the WorkstreamSnapshot — `loadWorkstreamSnapshot`
//     already runs `listLiveAgents(...)` once per tick, which populates
//     `report.prunedGhosts`.
//   - Reads `workspaceOrphans` straight out of the snapshot too.
//   - NO subprocess shellouts. The `tmux -V` check from the textual
//     `mu doctor` is intentionally OMITTED here — the TUI is
//     already running inside a terminal so tmux's binary presence
//     is implicit, and adding a per-tick subprocess fork to a
//     polled dashboard is the wrong tradeoff. If a future task
//     wants tmux-presence on the dashboard, add it as a
//     once-per-session probe in <App> (mirrors probeClipboardBackend),
//     not as a per-tick check here.
//
// CHECK SHAPE (matches the textual doctor's per-row vocabulary):
//   { name, status: "ok" | "warn" | "fail", detail }
//
// The card filters to non-OK rows for its body; subtitle counts
// warn+fail. When everything is OK the card renders a quiet
// "all healthy" line so the operator's eye learns to read the
// presence of rows as "something needs attention."

import { CURRENT_SCHEMA_VERSION, type Db, EXPECTED_TABLES } from "./db.js";
import type { WorkstreamSnapshot } from "./state.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  /** Short, stable identifier — used as the row label. Lowercase
   *  one-word tokens so the column-aligned card layout looks tidy. */
  name: string;
  status: DoctorStatus;
  /** Free-form prose for the row's right-hand column. Kept short so
   *  the card's CLIP column doesn't truncate it on common widths. */
  detail: string;
}

export interface DoctorSummary {
  /** Every check that ran, in stable display order. The card filters
   *  to non-OK rows for its body but keeps the OK rows so the popup
   *  (when it ships under feat_more_cards_umbrella) can render the
   *  full list. */
  checks: readonly DoctorCheck[];
  /** Convenience: how many rows are warn or fail. Card subtitle
   *  reads this directly. Pure derivation from `checks`. */
  problemCount: number;
}

/**
 * Compute the doctor summary for a workstream. Pure-ish: runs cheap
 * synchronous DB queries + reads from the supplied snapshot. Callers
 * that don't want to compute a snapshot first (or are running inside
 * `loadWorkstreamSnapshot` mid-build) can omit `snapshot` — the
 * snapshot-derived checks (ghosts / orphans / workspace-orphans) are
 * skipped in that case.
 */
export function loadDoctorSummary(db: Db, snapshot: WorkstreamSnapshot | null): DoctorSummary {
  const checks: DoctorCheck[] = [];

  // ─ schema (table presence) ──────────────────────────────────────
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length === 0) {
      checks.push({
        name: "schema",
        status: "ok",
        detail: `${EXPECTED_TABLES.length} tables`,
      });
    } else {
      checks.push({
        name: "schema",
        status: "fail",
        detail: `missing: ${missing.join(", ")}`,
      });
    }
  } catch (err) {
    checks.push({
      name: "schema",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─ schema_version ────────────────────────────────────────────────
  try {
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
      | { version: number }
      | undefined;
    const v = row?.version;
    if (v === undefined) {
      checks.push({
        name: "schema_version",
        status: "fail",
        detail: `missing row (expected ${CURRENT_SCHEMA_VERSION})`,
      });
    } else if (v === CURRENT_SCHEMA_VERSION) {
      checks.push({ name: "schema_version", status: "ok", detail: String(v) });
    } else if (v < CURRENT_SCHEMA_VERSION) {
      checks.push({
        name: "schema_version",
        status: "warn",
        detail: `${v} (code expects ${CURRENT_SCHEMA_VERSION})`,
      });
    } else {
      checks.push({
        name: "schema_version",
        status: "fail",
        detail: `${v} (code expects ${CURRENT_SCHEMA_VERSION}; downgrade?)`,
      });
    }
  } catch {
    checks.push({
      name: "schema_version",
      status: "fail",
      detail: "unreadable",
    });
  }

  // ─ journal_mode ─────────────────────────────────────────────────
  try {
    const journal = db.pragma("journal_mode", { simple: true });
    if (journal === "wal") {
      checks.push({ name: "journal_mode", status: "ok", detail: String(journal) });
    } else {
      checks.push({
        name: "journal_mode",
        status: "warn",
        detail: `${journal} (expected wal)`,
      });
    }
  } catch (err) {
    checks.push({
      name: "journal_mode",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─ foreign_keys ─────────────────────────────────────────────────
  try {
    const fk = db.pragma("foreign_keys", { simple: true });
    if (fk === 1) {
      checks.push({ name: "foreign_keys", status: "ok", detail: "on" });
    } else {
      checks.push({
        name: "foreign_keys",
        status: "fail",
        detail: `off (${fk})`,
      });
    }
  } catch (err) {
    checks.push({
      name: "foreign_keys",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─ snapshot-derived checks (ghosts / orphans) ───────────────────
  if (snapshot !== null) {
    const ghosts = snapshot.view.report.prunedGhosts;
    if (ghosts === 0) {
      checks.push({ name: "agents", status: "ok", detail: "no ghost panes" });
    } else {
      checks.push({
        name: "agents",
        status: "warn",
        detail: `${ghosts} ghost pane${ghosts === 1 ? "" : "s"}; run \`mu state\` or \`mu agent list\` to reap`,
      });
    }
    const orphanPanes = snapshot.view.orphans.length;
    if (orphanPanes === 0) {
      checks.push({ name: "panes", status: "ok", detail: "no orphan panes" });
    } else {
      checks.push({
        name: "panes",
        status: "warn",
        detail: `${orphanPanes} orphan pane${orphanPanes === 1 ? "" : "s"}; run \`mu agent adopt\``,
      });
    }
    const orphanWorkspaces = snapshot.workspaceOrphans.length;
    if (orphanWorkspaces === 0) {
      checks.push({ name: "workspaces", status: "ok", detail: "no orphan dirs" });
    } else {
      checks.push({
        name: "workspaces",
        status: "warn",
        detail: `${orphanWorkspaces} orphan dir${orphanWorkspaces === 1 ? "" : "s"}; run \`mu workspace orphans\``,
      });
    }
  }

  return { checks, problemCount: countProblems(checks) };
}

/** Count of warn + fail rows. Pure; exported for unit tests. */
export function countProblems(checks: readonly DoctorCheck[]): number {
  let n = 0;
  for (const c of checks) if (c.status !== "ok") n++;
  return n;
}

/**
 * Return the full check array (OK + warn + fail) in stable display
 * order. Used by the TUI's slot-9 Doctor popup
 * (feat_popup_9_doctor, workstream `tui-impl`) which renders every
 * row — not just the non-OK subset Card 9 surfaces.
 *
 * Thin wrapper over `loadDoctorSummary` so the SDK seam stays
 * single: `loadDoctorSummary` is the source of truth for the
 * check vocabulary, and the popup's `loadDoctorChecks` view is
 * just `.checks`. Pure-ish (same cheap synchronous DB reads as
 * `loadDoctorSummary`).
 */
export function loadDoctorChecks(
  db: Db,
  snapshot: WorkstreamSnapshot | null,
): readonly DoctorCheck[] {
  return loadDoctorSummary(db, snapshot).checks;
}

// ─── pure helpers (per-check remediation hints) ────────────────────
//
// These map a `DoctorCheck.name` to either (a) a single-line
// informational shell command suitable for yank/paste, or (b) a
// short multi-line paragraph explaining the failure shape. They
// originally lived next to the slot-9 Doctor popup
// (src/cli/tui/popups/doctor.tsx) but moved here per
// review_tui_doctor_remediation_lives_in_popup: neither function
// has any rendering concern (both return plain strings) and the
// popup's `renderDrillBody` was the only render-layer caller.
// Living here keeps every per-check fact in one file so adding a
// new check is a single touchpoint, and lets future SDK consumers
// (e.g. a `mu doctor --remediation` flag) reach the same data
// without depending on the TUI render layer.
//
// READ-ONLY by construction. Even when a check is `fail`, the yank
// recipe is the diagnostic verb the operator should RUN MANUALLY,
// never a mutating fix. Schema-shape checks (no actionable
// mutation) yank a `# ...` comment line so the muscle-memory of
// `y` still gives feedback.

/**
 * Map a check row to the most useful informational command the
 * operator might paste. Read-only by construction: `mu agent list`,
 * `mu workspace orphans`, `mu doctor` are all SELECT-shape verbs;
 * `# ...` lines are visibly inert. Per the slot-9 popup spec KEY
 * MAP block this is INFORMATIONAL, never a mutating recipe — so
 * even when the check is `fail`, we yank the diagnostic verb the
 * operator should RUN MANUALLY, not a fix command.
 *
 * Pure; exported for unit tests + SDK reuse.
 */
export function yankCommandForCheck(check: Pick<DoctorCheck, "name" | "status">): string {
  switch (check.name) {
    case "agents":
      // Diagnostic/reaping read: `mu state` and `mu agent list` both
      // reconcile missing panes. Prefer the canonical state card; the
      // detailed agent list remains in the doctor detail text.
      return "mu state";
    case "panes":
      // Orphan tmux panes — the standard adoption recipe.
      return "mu agent adopt";
    case "workspaces":
      // Diagnostic: list orphan workspace dirs. Operator decides
      // whether to `mu workspace free` from the list output.
      return "mu workspace orphans";
    case "schema":
    case "schema_version":
    case "journal_mode":
    case "foreign_keys":
      // No actionable mutation an operator should yank for
      // schema-shape checks (the migration runner is the SDK seam,
      // not a CLI verb). Yank a no-op comment so the muscle memory
      // of `y` still gives feedback. When fail, the textual
      // `mu doctor` carries the full diagnostic.
      return `# ${check.name}: see \`mu doctor\` for full diagnostic`;
    default:
      // Forward-compat: any future check name falls back to the
      // textual `mu doctor` verb. Read-only.
      return "mu doctor";
  }
}

/**
 * A short paragraph (one paragraph per check name) explaining the
 * shape of the failure / warning. Returned as a `readonly string[]`
 * so the popup's drill body can interleave the lines with other
 * content; CLI consumers can `.join("\n")` themselves.
 *
 * Pure; exported for unit tests + SDK reuse.
 */
export function remediationParagraph(check: DoctorCheck): readonly string[] {
  switch (check.name) {
    case "agents":
      return [
        "A 'ghost pane' is a registered agent whose tmux pane is gone.",
        "Doctor only reports the count. Run `mu state` or `mu agent list`",
        "to reap ghost agents and return their IN_PROGRESS tasks to OPEN.",
        "The TUI is read-only, but its slow tick uses the same state reap.",
      ];
    case "panes":
      return [
        "An 'orphan pane' is a live tmux pane in the workstream's",
        "session that mu doesn't know about. Adopt it via",
        "`mu agent adopt <pane-id>` to register it as a managed agent,",
        "or kill it manually if it's not yours.",
      ];
    case "workspaces":
      return [
        "An 'orphan workspace dir' is a per-agent VCS workspace under",
        "the workstream that has no matching mu agent row. Run",
        "`mu workspace orphans -w <ws>` to list them, then",
        "`mu workspace free <agent>` to release each one.",
      ];
    case "schema":
      return [
        "Missing tables typically mean an older mu binary opened the",
        "DB without running migrations. Rebuild mu (npm run build)",
        "and re-open; openDb runs the migration block on every",
        "process start.",
      ];
    case "schema_version":
      return [
        "Schema version mismatch means the DB was opened by a",
        "different mu binary than the one running now. If `<` the",
        "expected version, openDb should have migrated — check the",
        "build. If `>` the expected, you may have a downgrade in",
        "progress; restore from a snapshot rather than continuing.",
      ];
    case "journal_mode":
      return [
        "WAL is the default journal mode for SQLite under mu. A",
        "different mode (e.g. `delete`) means an external tool",
        "rewrote the DB pragma. Re-open the DB with mu to restore.",
      ];
    case "foreign_keys":
      return [
        "Foreign keys must be ON for mu's CASCADE deletes to work.",
        "An OFF value usually means an external SQLite client opened",
        "the DB without `PRAGMA foreign_keys = ON`. Re-open with mu.",
      ];
    default:
      return ["See `mu doctor` for the canonical textual diagnostic."];
  }
}
