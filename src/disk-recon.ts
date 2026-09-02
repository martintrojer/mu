// mu — disk↔DB reconciliation for `mu doctor`.
//
// Every other check in doctor reads the DB. These read the STATE DIR, and
// then compare the two, because the two can disagree in both directions
// and nothing surfaced either one:
//
//   disk has, DB doesn't  ->  workspace orphan / empty parent / residue
//   DB has, disk doesn't  ->  a `vcs_workspaces` row pointing at nothing
//
// The second direction had NO surface at all before this module.
// `mu workspace list` prints such a row as if it were fine, and every
// spawn that reuses it fails deep in the VCS backend with a path error
// rather than at the row that lied.
//
// REPORT ONLY, on purpose. Each finding names its own cleanup command in
// the remediation block and mu runs none of them: an operator or an agent
// reading doctor's output decides. A diagnostic verb that deletes 300MB
// of checkouts because a readdir raced a spawn is a worse bug than the
// residue it removes.
//
// TIERED like the drift check. The default tier is readdir + stat, depth
// 2 (measured ~1ms on a 5-workstream / 5196-file state dir). Recursive
// byte accounting is `--disk` only: its cost scales with the checkout,
// not with mu's own state, so it must not ride a reflexively-run command.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Db, defaultDbPath, defaultStateDir } from "./db.js";
import type { FleetHazard } from "./fleet-hazards.js";
import { listAllOrphanWorkspaces, listWorkspaces } from "./workspace.js";

/** A held lock dir older than this is presumed abandoned. Mirrors
 *  `DEFAULT_STALE_LOCK_MS` in src/file-lock.ts — that value governs
 *  whether a lock is STOLEN when contended, this one whether it is
 *  REPORTED when nobody is contending it, and a lock nobody contends is
 *  never stolen. Deliberately much larger: a lock 30s old is routine
 *  mid-spawn, whereas one an hour old outlived its process. */
export const STALE_LOCK_REPORT_MS = 60 * 60 * 1000;

/** Human-readable byte count. Doctor rows are narrow, so no decimals
 *  above the MB mark. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** Best-effort `readdir`: an unreadable or absent dir reads as empty, so
 *  a fresh install with no state dir yet reports "ok" rather than
 *  throwing out of a diagnostic. */
function dirNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ─── DB → disk: rows pointing at nothing ──────────────────────────────

export interface MissingWorkspaceDir {
  agentName: string;
  workstreamName: string;
  path: string;
}

/**
 * `vcs_workspaces` rows whose `path` is not on disk.
 *
 * The inverse of a workspace orphan, and the more dangerous half: an
 * orphan dir merely blocks the next `--workspace` spawn with a clear
 * "path not empty", while a row pointing at a deleted directory is
 * reported as a healthy workspace by every read surface mu has. The
 * usual cause is a hand-run `rm -rf` (or a `git worktree remove`) on a
 * path that `mu workspace free` would have unregistered.
 */
export function findMissingWorkspaceDirs(db: Db): MissingWorkspaceDir[] {
  return listWorkspaces(db)
    .filter((row) => !exists(row.path))
    .map((row) => ({
      agentName: row.agentName,
      workstreamName: row.workstreamName,
      path: row.path,
    }));
}

export function checkMissingWorkspaceDirs(db: Db): FleetHazard {
  const missing = findMissingWorkspaceDirs(db);
  if (missing.length === 0) {
    return { name: "ws-rows", severity: "ok", detail: "every workspace row has its dir" };
  }
  return {
    name: "ws-rows",
    severity: "warn",
    detail: `${missing.length} workspace row(s) point at a path that is gone`,
    remediation: [
      "These vcs_workspaces rows name a directory that no longer exists:",
      ...missing.map((m) => `  ${m.workstreamName}/${m.agentName}  ${m.path}`),
      "",
      "mu reports such a row as a healthy workspace on every read surface, and",
      "the next send or refresh against it fails inside the VCS backend rather",
      "than at the row that lied. Unregister them:",
      ...missing.map((m) => `  mu workspace free ${m.agentName} -w ${m.workstreamName}`),
    ],
  };
}

// ─── disk → DB: dirs with no row ──────────────────────────────────────

/**
 * Workspace orphans, wired into doctor.
 *
 * `listAllOrphanWorkspaces` predates this module and was reachable only
 * from `mu workspace orphans` and the TUI card — so an operator running
 * `mu doctor` to answer "is anything wrong" was told nothing about
 * directories that will fail their next spawn. `stranded` rows (the
 * parent workstream's row is gone too) are counted separately because
 * they cannot be cleaned by any workstream-scoped verb.
 */
export function checkWorkspaceOrphanDirs(db: Db): FleetHazard {
  const orphans = listAllOrphanWorkspaces(db);
  if (orphans.length === 0) {
    return { name: "ws-dirs", severity: "ok", detail: "no orphan workspace dirs" };
  }
  const stranded = orphans.filter((o) => o.stranded);
  const strandedNote = stranded.length > 0 ? `, ${stranded.length} stranded` : "";
  return {
    name: "ws-dirs",
    severity: "warn",
    detail: `${orphans.length} workspace dir(s) with no DB row${strandedNote}`,
    remediation: [
      "These directories have no row in vcs_workspaces:",
      ...orphans.map((o) => `  ${o.path}${o.stranded ? "   (workstream row also gone)" : ""}`),
      "",
      "Each one blocks the next `--workspace` spawn for that agent name. mu will",
      "not remove them: they may hold uncommitted work, and a stranded dir is the",
      "only remaining copy of it. Inspect, then remove by hand:",
      "  mu workspace orphans --all",
      ...orphans.slice(0, 3).map((o) => `  rm -rf ${o.path}`),
    ],
  };
}

/**
 * `<state-dir>/workspaces/<workstream>/` dirs with no children.
 *
 * Left behind by `mu workspace free`, which removes the agent dir and
 * its row but never the per-workstream parent. Harmless — it is
 * `severity: "ok"` for that reason — but reported because it is the
 * cheapest possible signal that a workstream is done with its
 * checkouts, and because an operator counting directories to work out
 * what mu still holds should not have to open each one.
 */
export function checkEmptyWorkstreamDirs(): FleetHazard {
  const root = join(defaultStateDir(), "workspaces");
  const empty = dirNames(root).filter((name) => dirNames(join(root, name)).length === 0);
  if (empty.length === 0) {
    return { name: "ws-empty", severity: "ok", detail: "no empty workstream dirs" };
  }
  return {
    name: "ws-empty",
    severity: "ok",
    detail: `${empty.length} empty workstream dir(s): ${empty.slice(0, 4).join(", ")}`,
    remediation: [
      "These per-workstream workspace dirs hold no checkouts:",
      ...empty.map((name) => `  ${join(root, name)}`),
      "",
      "`mu workspace free` removes an agent's dir and its row but not the parent,",
      "so this is normal residue rather than a fault. Remove if you want the",
      "state dir to read cleanly:",
      ...empty.slice(0, 3).map((name) => `  rmdir ${join(root, name)}`),
    ],
  };
}

// ─── residue: files no DB row references ──────────────────────────────

export interface StrayFile {
  name: string;
  path: string;
  bytes: number;
}

/**
 * `mu.db.*` files in the state dir that are not the live WAL triple.
 *
 * Hand-made copies (`mu.db.old`), pre-bump saves (`mu.db.v9-<stamp>`)
 * and their abandoned `-wal` / `-shm` sidecars. Nothing in mu writes or
 * reads them, nothing prunes them, and they are the largest single
 * category of dead bytes in a long-lived state dir — 50MB on the box
 * this check was written against.
 *
 * The live triple is excluded by exact name, so a `MU_DB_PATH` pointing
 * elsewhere simply reports the default-path copies it finds, which is
 * the honest answer.
 */
export function findStrayDbFiles(stateDir: string = defaultStateDir()): StrayFile[] {
  const live = new Set(["mu.db", "mu.db-wal", "mu.db-shm"]);
  let entries: string[];
  try {
    entries = readdirSync(stateDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith("mu.db") && !live.has(name))
    .map((name) => ({ name, path: join(stateDir, name), bytes: sizeOf(join(stateDir, name)) }))
    .sort((a, b) => b.bytes - a.bytes);
}

export function checkStrayDbFiles(): FleetHazard {
  const stateDir = defaultStateDir();
  const stray = findStrayDbFiles(stateDir);
  if (stray.length === 0) {
    return { name: "db-copies", severity: "ok", detail: "no stray DB copies" };
  }
  const total = stray.reduce((n, f) => n + f.bytes, 0);
  return {
    name: "db-copies",
    severity: "warn",
    detail: `${stray.length} stray DB file(s), ${formatBytes(total)} — nothing reads these`,
    remediation: [
      `Files matching mu.db* in ${stateDir} that are not the live WAL triple:`,
      ...stray.map((f) => `  ${formatBytes(f.bytes).padStart(6)}  ${f.name}`),
      "",
      `Live DB: ${defaultDbPath()}`,
      "",
      "These are hand-made copies and pre-upgrade saves. No mu code path reads",
      "them and none prunes them. Real disaster recovery is the ops log, so a",
      "copy is only ever a convenience:",
      "  mu rebuild <file>        # DR from the ops log, not from a copy",
      "  mu db backup <file>      # a fresh copy, if that is what you wanted",
    ],
  };
}

/**
 * `<state-dir>/exports/` — residue of a verb that no longer exists.
 *
 * `mu workstream export` and its markdown bucket were deleted in 1.0.
 * The directory it wrote to was not, so every export any earlier version
 * ever made is still on disk with no surface in mu that names it. This
 * is the one finding here that is a defect rather than housekeeping:
 * mu removed the producer and left the output unreferenced.
 */
export function checkRemovedExportsDir(): FleetHazard {
  const root = join(defaultStateDir(), "exports");
  const entries = dirNames(root);
  if (entries.length === 0) {
    return { name: "exports", severity: "ok", detail: "no leftover export dirs" };
  }
  return {
    name: "exports",
    severity: "warn",
    detail: `${entries.length} export dir(s) from the removed \`mu workstream export\``,
    remediation: [
      `${root} holds ${entries.length} directory/ies.`,
      "",
      "`mu workstream export` and its markdown bucket were removed in 1.0; this",
      "is output from a version that still had it. Nothing in mu reads or prunes",
      "it. Keep anything you still want, then:",
      `  rm -rf ${root}`,
    ],
  };
}

/**
 * Lock dirs in `<state-dir>/locks/` older than STALE_LOCK_REPORT_MS.
 *
 * `withFileLock` steals a lock older than 30s, so a stale lock is not a
 * deadlock and this is not a `fail`. But it only steals when something
 * CONTENDS, and an uncontended lock dir survives forever — so an hour-old
 * lock is a crashed process's headstone, worth naming because it is
 * evidence of a spawn or flush that died mid-critical-section.
 */
export function checkStaleLocks(now: number = Date.now()): FleetHazard {
  const root = join(defaultStateDir(), "locks");
  const stale: { name: string; ageMs: number }[] = [];
  for (const name of dirNames(root)) {
    try {
      const ageMs = now - statSync(join(root, name)).mtimeMs;
      if (ageMs > STALE_LOCK_REPORT_MS) stale.push({ name, ageMs });
    } catch {
      // Vanished between readdir and stat: released, which is the
      // outcome we wanted anyway.
    }
  }
  if (stale.length === 0) {
    return { name: "locks", severity: "ok", detail: "no stale lock dirs" };
  }
  return {
    name: "locks",
    severity: "warn",
    detail: `${stale.length} lock dir(s) older than 1h`,
    remediation: [
      "These advisory-lock dirs outlived the process that took them:",
      ...stale.map((s) => `  ${s.name}  (${Math.round(s.ageMs / 60000)}m old)`),
      "",
      "Not a deadlock: withFileLock steals a lock older than 30s. But it only",
      "steals under contention, so these will sit here forever. They are evidence",
      "of a spawn or segment flush that died mid-critical-section.",
      `  rm -rf ${root}/<name>`,
    ],
  };
}

// ─── --disk tier: recursive byte accounting ───────────────────────────

export interface WorkspaceUsage {
  workstreamName: string;
  agentName: string;
  path: string;
  bytes: number;
  /** True iff no `vcs_workspaces` row references this path — the bytes
   *  are reclaimable without freeing anything mu still tracks. */
  orphan: boolean;
}

/** Recursive byte sum. Symlinks are counted at link size (`statSync`
 *  without following) so a workspace symlinked into a huge tree does not
 *  report that tree's bytes as mu's. */
function walkBytes(path: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += walkBytes(child);
    else if (entry.isFile()) total += sizeOf(child);
  }
  return total;
}

/**
 * Per-workspace disk usage, `--disk` tier only.
 *
 * Cost scales with the size of the CHECKOUTS, not with mu's own state
 * (measured 0.25s / 574MB / 5196 files), which is why it is not in the
 * default tier: a monorepo workspace would make `mu doctor` slow enough
 * that people stop running it, and a diagnostic nobody runs reports
 * nothing.
 */
export function measureWorkspaceUsage(db: Db): WorkspaceUsage[] {
  const root = join(defaultStateDir(), "workspaces");
  const registered = new Set(listWorkspaces(db).map((w) => w.path));
  const usage: WorkspaceUsage[] = [];
  for (const wsName of dirNames(root)) {
    const wsRoot = join(root, wsName);
    for (const agentName of dirNames(wsRoot)) {
      const path = join(wsRoot, agentName);
      usage.push({
        workstreamName: wsName,
        agentName,
        path,
        bytes: walkBytes(path),
        orphan: !registered.has(path),
      });
    }
  }
  return usage.sort((a, b) => b.bytes - a.bytes);
}

// ─── the aggregate ────────────────────────────────────────────────────

/**
 * Every disk↔DB check, in display order: the two reconciliation
 * directions first (those are inconsistencies), then residue.
 *
 * Cheap enough for the default doctor: one readdir of the state dir,
 * a depth-2 readdir of `workspaces/`, one `stat` per workspace row and
 * per lock dir.
 */
export function checkDiskRecon(db: Db): FleetHazard[] {
  return [
    checkMissingWorkspaceDirs(db),
    checkWorkspaceOrphanDirs(db),
    checkEmptyWorkstreamDirs(),
    checkStrayDbFiles(),
    checkRemovedExportsDir(),
    checkStaleLocks(),
  ];
}
