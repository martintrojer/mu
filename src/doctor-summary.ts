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
//     already runs `listLiveAgents(..., mode: "status-only")` once
//     per tick, which populates `report.prunedGhosts` (the
//     would-be-pruned count; status-only is non-mutating).
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
        detail: `${ghosts} ghost pane${ghosts === 1 ? "" : "s"}; run \`mu agent list\``,
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
