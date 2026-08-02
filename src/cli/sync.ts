// mu — `mu sync`: ONE verb, whose bare form is a PEER STATUS REPORT.
//
// The sync itself is incidental. Every mu invocation already flushes and
// ingests (the ambient hook in src/cli/handle.ts), so a verb that only
// did that would exist for reassurance. What no other command answers is
// "who are my peers, how far behind am I, and when did I last hear from
// them" — so that is what the bare form prints:
//
//   $ mu sync
//   flushed 14 ops · ingested 22 from 1 peer
//   machine   last seen   behind
//   devbox    2m ago      0
//   desktop   3d ago      47   ← stale
//
// It keeps its bare form for scripting ergonomics too: `rsync ... && mu
// sync` reads correctly where `rsync ... && mu state` reads like an
// accident.
//
// TWO FLAGS, AND ONLY TWO, because nothing else can express them:
//
//   --from <path>    a DIFFERENT READER — a peer's `mu.db` ops table via
//                    SQLite rather than a JSONL segment. For an sshfs
//                    mount or a copied file.
//   --repair <peer>  reset that peer's watermark and re-read its segment
//                    from zero. Safe because ingest is idempotent via
//                    UNIQUE (machine_id, hlc).
//
// DELIBERATELY ABSENT: `mu peers` (folded into the bare form here), and
// `--to <dir>` / `--from <dir>`. A one-off directory needs no flag —
// `MU_SYNC_DIR=/mnt/usb mu state` already ingests from the USB stick
// using the repo's existing env-var-override idiom, and adding a flag for
// it would be a second way to say the same thing.
//
// ALSO ABSENT, permanently: `--push` / `--pull <host>`. mu reads and
// writes FILES; the operator owns transport (a standing ROADMAP pledge).
// When a peer is stale we PRINT an rsync line and let them paste it.
//
// This verb opts OUT of the ambient hook (`ambientSync: false`) and runs
// the pass itself. Not to skip work — to report honest numbers. If the
// hook ran first, its ingest would have consumed everything and the
// report would print "ingested 0" immediately after doing the opposite.

import { emitJson, handle, JSON_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { muTable, type NextStep, pc, printNextSteps } from "../output.js";
import { type IngestResult, syncDir, syncPass } from "../segments.js";
import {
  type IngestFromDbResult,
  ingestFromDb,
  type PeerStatus,
  peerStatuses,
  repairPeer,
  transportNextSteps,
} from "../sync.js";
import { relTime } from "./format.js";

export interface SyncCmdOptions {
  json?: boolean;
  from?: string;
  repair?: string;
}

/** Relative time, or a marker when transport never delivered anything. */
function lastSeen(peer: PeerStatus): string {
  if (peer.ageMs === null) return "—";
  return `${relTime(peer.ageMs)} ago`;
}

function setupNextSteps(): NextStep[] {
  return [
    {
      intent: "Turn sync on (one env var, on every machine)",
      command: "export MU_SYNC_DIR=$HOME/Sync/mu",
    },
    {
      intent: "Then share that folder (Syncthing, rsync, a USB stick)",
      command: "# any file-mover works: segments are append-only, single-writer",
    },
  ];
}

function nextSteps(dir: string, peers: readonly PeerStatus[]): NextStep[] {
  const steps: NextStep[] = [...transportNextSteps(dir, peers)];
  const damaged = peers.filter((p) => p.behind > 0);
  const first = damaged[0];
  if (first !== undefined) {
    steps.push({
      intent: "Re-read a peer's segment from zero",
      command: `mu sync --repair ${first.short}`,
    });
  }
  if (steps.length === 0) {
    steps.push({ intent: "See what landed", command: "mu log --limit 20" });
  }
  return steps;
}

function renderPeerTable(peers: readonly PeerStatus[]): string {
  if (peers.length === 0) {
    return pc.dim("  (no peers yet — drop another machine's segment in the sync dir)");
  }
  const table = muTable({
    head: [pc.bold("machine"), pc.bold("last seen"), pc.bold("behind"), pc.bold("")],
  });
  for (const peer of peers) {
    const flags: string[] = [];
    if (peer.stale) flags.push(pc.yellow("← stale"));
    if (peer.conflictCopy) flags.push(pc.dim("(conflict copy)"));
    table.push([peer.short, lastSeen(peer), String(peer.behind), flags.join(" ")]);
  }
  return table.toString();
}

/** "ingested 22 from 2 peers", or the honest nothing-happened form. */
function describeIngest(results: readonly IngestResult[]): string {
  const total = results.reduce((sum, r) => sum + r.applied, 0);
  const from = results.filter((r) => r.applied > 0).length;
  if (total === 0) return "ingested 0";
  return `ingested ${total} from ${from} peer${from === 1 ? "" : "s"}`;
}

export async function cmdSync(db: Db, opts: SyncCmdOptions = {}): Promise<void> {
  const dir = syncDir();

  // `--from <path>` is the one shape that works with sync unconfigured:
  // it names its source outright, so there is no dir to need.
  if (opts.from !== undefined) {
    const result = ingestFromDb(db, opts.from);
    // Flush afterwards so the ops we just took on are in our own segment
    // for any peer sharing the dir — that is how a laptop relays the
    // devserver's work to a third machine (gossip, for free).
    const flushed = dir === null ? null : await syncPass(db, dir);
    emitFrom(db, result, flushed?.flushed.appended ?? 0, dir, opts);
    return;
  }

  if (dir === null) {
    if (opts.json === true) {
      emitJson({
        syncDir: null,
        enabled: false,
        flushed: 0,
        ingested: [],
        peers: [],
        nextSteps: setupNextSteps(),
      });
      return;
    }
    console.log(pc.dim("sync is off (MU_SYNC_DIR is not set)"));
    printNextSteps(setupNextSteps());
    return;
  }

  // `--repair` is just "reset the watermark"; the pass below then
  // re-reads that peer's segment from zero. Resolved BEFORE the pass so a
  // bad ref errors without half-doing anything.
  const repaired = opts.repair === undefined ? null : repairPeer(db, opts.repair, dir);

  const pass = await syncPass(db, dir);
  const peers = peerStatuses(db, dir);

  if (opts.json === true) {
    emitJson({
      syncDir: dir,
      enabled: true,
      repaired: repaired === null ? null : repaired.machineId,
      flushed: pass.flushed.appended,
      skippedLocal: pass.flushed.skippedLocal,
      ingested: pass.ingested.map((r) => ({
        machineId: r.machineId,
        applied: r.applied,
        changed: r.changed,
        watermark: r.watermark,
        defects: r.defects,
      })),
      peers,
      nextSteps: nextSteps(dir, peers),
    });
    return;
  }

  if (repaired !== null) {
    console.log(pc.dim(`repaired ${repaired.short}: watermark reset, re-reading from zero`));
  }
  console.log(`flushed ${pass.flushed.appended} ops · ${describeIngest(pass.ingested)}`);
  console.log(renderPeerTable(peers));
  for (const result of pass.ingested) {
    for (const defect of result.defects) {
      console.log(
        pc.yellow(
          `  ${result.machineId.slice(0, 8)}: ${defect.kind} at line ${defect.line} — ${defect.detail}`,
        ),
      );
    }
  }
  printNextSteps(nextSteps(dir, peers));
}

function emitFrom(
  db: Db,
  result: IngestFromDbResult,
  flushed: number,
  dir: string | null,
  opts: SyncCmdOptions,
): void {
  const peers = dir === null ? [] : peerStatuses(db, dir);
  if (opts.json === true) {
    emitJson({
      from: result.path,
      read: result.read,
      changed: result.changed,
      skippedLocal: result.skippedLocal,
      flushed,
      peers,
      nextSteps: [{ intent: "See what landed", command: "mu log --limit 20" }],
    });
    return;
  }
  console.log(
    `read ${result.read} ops from ${pc.bold(result.path)} · ${result.changed} changed rows`,
  );
  if (result.skippedLocal > 0) {
    console.log(pc.dim(`  skipped ${result.skippedLocal} machine-local ops (they never travel)`));
  }
  printNextSteps([{ intent: "See what landed", command: "mu log --limit 20" }]);
}

// ─── commander wiring ────────────────────────────────────────────────

import type { Command } from "commander";

export function wireSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Report peer status (flush + ingest happen on every mu invocation anyway)")
    .option(...JSON_OPT)
    .option("--from <path>", "ingest from a peer's mu.db directly (sshfs mount or copied file)")
    .option("--repair <peer>", "reset that peer's watermark and re-read its segment from zero")
    .action(function () {
      const opts = (this as Command).opts() as SyncCmdOptions;
      // ambientSync: false — this verb IS the pass, and running it twice
      // would print "ingested 0" for work the hook had just done.
      return handle((db) => cmdSync(db, opts), this as Command, { ambientSync: false })();
    });
}
