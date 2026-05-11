// mu — `mu log` verb (write + read + tail).
//
// One verb, three modes:
//   mu log "text"            → write
//   mu log                    → read latest 50
//   mu log --tail             → blocking subscription (poll every 1s)
//   mu log --since <seq>      → cursor read (everything after seq)
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { getAgentByPane } from "../agents.js";
import { emitJson, emitJsonCollection, printLogRow, resolveOptionalWorkstream } from "../cli.js";
import type { Db } from "../db.js";
import { type ListLogsOptions, appendLog, latestSeq, listLogs } from "../logs.js";
import { pc } from "../output.js";

export interface LogReadOpts {
  workstream?: string;
  allWorkstreams?: boolean;
  since?: number;
  lines?: number;
  source?: string;
  kind?: string;
  json?: boolean;
  tail?: boolean;
}

export interface LogWriteOpts {
  workstream?: string;
  as?: string;
  kind?: string;
}

/**
 * The `mu log` verb is overloaded: with a positional <text>, write
 * an entry; without, read the log (optionally tailing).
 */
export async function cmdLog(
  db: Db,
  text: string | undefined,
  opts: LogReadOpts & LogWriteOpts,
): Promise<void> {
  if (text !== undefined && text.length > 0) {
    await cmdLogWrite(db, text, opts);
    return;
  }
  await cmdLogRead(db, opts);
}

/**
 * Resolve who/where this log entry belongs to:
 *   --as <name>      explicit override; workstream still resolved below
 *   $TMUX_PANE       agent name + workstream from the agent row
 *   else             source = 'user', workstream from -w / $MU_SESSION /
 *                    tmux session, or null if none of those resolve
 */
async function resolveLogContext(
  db: Db,
  opts: { as?: string; workstream?: string },
): Promise<{ source: string; workstream: string | null }> {
  if (opts.as) {
    const workstream = opts.workstream ?? (await resolveOptionalWorkstream());
    return { source: opts.as, workstream };
  }
  const paneId = process.env.TMUX_PANE;
  if (paneId) {
    const agent = getAgentByPane(db, paneId);
    if (agent) {
      // Pane branch is intentionally asymmetric: when no -w is given, the
      // agent's own workstream wins over $MU_SESSION / tmux session, since
      // the agent row is the more authoritative binding. Don't "fix" this
      // to call resolveOptionalWorkstream() like the other branches.
      return {
        source: agent.name,
        workstream: opts.workstream ?? agent.workstreamName,
      };
    }
  }
  const workstream = opts.workstream ?? (await resolveOptionalWorkstream());
  return { source: "user", workstream };
}

async function cmdLogWrite(db: Db, text: string, opts: LogWriteOpts): Promise<void> {
  const ctx = await resolveLogContext(db, opts);
  const row = appendLog(db, {
    workstream: ctx.workstream,
    source: ctx.source,
    kind: opts.kind ?? "message",
    payload: text,
  });
  console.log(
    pc.dim(
      `seq ${row.seq}  workstream=${row.workstreamName ?? "—"}  source=${row.source}  kind=${row.kind}`,
    ),
  );
}

async function cmdLogRead(db: Db, opts: LogReadOpts): Promise<void> {
  const workstream = await logReadWorkstream(opts);
  const listOpts: ListLogsOptions = {};
  if (workstream !== undefined) listOpts.workstream = workstream;
  if (opts.source !== undefined) listOpts.source = opts.source;
  if (opts.kind !== undefined) listOpts.kind = opts.kind;

  if (opts.tail) {
    await cmdLogTail(db, listOpts, opts);
    return;
  }

  if (opts.since !== undefined) listOpts.since = opts.since;
  if (opts.lines !== undefined) listOpts.limit = opts.lines;
  // Default cap: latest 50 entries when no `since` and no `--lines`.
  if (opts.since === undefined && opts.lines === undefined) listOpts.limit = 50;

  const rows = listLogs(db, listOpts);
  if (opts.json) {
    emitJsonCollection(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim("(no log entries)"));
    return;
  }
  for (const row of rows) printLogRow(row);
}

/**
 * Resolve the `--workstream` filter for log reads:
 *   --all            → undefined (every workstream + machine-wide)
 *   --workstream X   → X
 *   $MU_SESSION etc. → the current workstream (default behaviour)
 *   none             → undefined (be permissive in read mode)
 */
async function logReadWorkstream(opts: LogReadOpts): Promise<string | undefined> {
  if (opts.allWorkstreams) return undefined;
  if (opts.workstream) return opts.workstream;
  const ws = await resolveOptionalWorkstream();
  return ws ?? undefined;
}

async function cmdLogTail(db: Db, baseOpts: ListLogsOptions, cliOpts: LogReadOpts): Promise<void> {
  // If --since wasn't given, start at "now" so the subscriber only sees
  // NEW entries. Pass `--since 0` to replay from the beginning.
  let cursor = cliOpts.since ?? latestSeq(db);
  if (!cliOpts.json) {
    console.log(
      pc.dim(
        `(tailing log; cursor=${cursor}; ${baseOpts.workstream ? `workstream=${baseOpts.workstream}` : "all workstreams"}; ctrl-c to exit)`,
      ),
    );
  }
  const intervalMs = defaultLogTailIntervalMs();
  for (;;) {
    const rows = listLogs(db, { ...baseOpts, since: cursor });
    for (const row of rows) {
      if (cliOpts.json) emitJson(row);
      else printLogRow(row);
      cursor = row.seq;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Tail interval default + safety floor. Mirrors defaultSpawnLivenessMs
 *  (src/agents.ts) and defaultSendDelayMs (src/tmux.ts). Naive
 *  `Number(env)` was a DOS-by-typo: an env value of '' parses as 0
 *  and any non-numeric value as NaN, both of which Node's setTimeout
 *  treats as 1ms — hammering SQLite at ~500 Hz on the next mu log
 *  --tail. Unparseable env → fall back to the no-env default of 1000ms;
 *  parseable but too-low → clamp up to the 50ms floor (so a deliberate
 *  `MU_LOG_TAIL_INTERVAL_MS=10` becomes 50, not 1000). */
const LOG_TAIL_INTERVAL_FLOOR_MS = 50;
const LOG_TAIL_INTERVAL_DEFAULT_MS = 1000;
function defaultLogTailIntervalMs(): number {
  const raw = process.env.MU_LOG_TAIL_INTERVAL_MS;
  if (raw === undefined) return LOG_TAIL_INTERVAL_DEFAULT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return LOG_TAIL_INTERVAL_DEFAULT_MS;
  return Math.max(LOG_TAIL_INTERVAL_FLOOR_MS, parsed);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireLogCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, WORKSTREAM_OPT, handle, parseLines, parseNonNegativeInt } from "../cli.js";

export function wireLogCommand(program: Command): void {
  // mu log — overloaded:
  //   mu log "text"            → write
  //   mu log                    → read latest 50
  //   mu log --tail             → blocking subscription (poll every 1s)
  //   mu log --since <seq>      → cursor read (everything after seq)
  program
    .command("log [text]")
    .description(
      "Write a log entry (with text) or read the log (without). --tail blocks and prints new entries as they land.",
    )
    .option("--as <name>", "override the source name (default: agent via $TMUX_PANE, else 'user')")
    .option("--kind <kind>", "kind tag (default: 'message' on write)")
    .option("--tail", "block and print entries as they're appended")
    .option(
      "--since <seq>",
      "return entries with seq strictly greater than this (use 0 to replay everything)",
      parseNonNegativeInt,
    )
    .option(
      "-n, --lines <n>",
      "cap to the latest N entries (default 50, no cap with --since)",
      parseLines,
    )
    .option("--source <name>", "filter by source")
    .option("--all", "read across every workstream (and machine-wide entries)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (text: string | undefined) {
      const raw = (this as Command).opts() as {
        as?: string;
        kind?: string;
        tail?: boolean;
        since?: number;
        lines?: number;
        source?: string;
        all?: boolean;
        workstream?: string;
        json?: boolean;
      };
      const opts: LogReadOpts & LogWriteOpts = {};
      if (raw.as !== undefined) opts.as = raw.as;
      if (raw.kind !== undefined) opts.kind = raw.kind;
      if (raw.tail !== undefined) opts.tail = raw.tail;
      if (raw.since !== undefined) opts.since = raw.since;
      if (raw.lines !== undefined) opts.lines = raw.lines;
      if (raw.source !== undefined) opts.source = raw.source;
      if (raw.all !== undefined) opts.allWorkstreams = raw.all;
      if (raw.workstream !== undefined) opts.workstream = raw.workstream;
      if (raw.json !== undefined) opts.json = raw.json;
      return handle((db) => cmdLog(db, text, opts), this as Command)();
    });
}
