// mu — `mu log` verb (write + read + tail).
//
// One verb, three modes:
//   mu log "text"            → write
//   mu log                    → read latest 50
//   mu log --tail             → blocking subscription (poll every 1s)
//   mu log --since <seq>      → cursor read (everything after seq)
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import pc from "picocolors";
import { getAgentByPane } from "../agents.js";
import { emitJson, printLogRow, resolveOptionalWorkstream } from "../cli.js";
import type { Db } from "../db.js";
import { type ListLogsOptions, appendLog, latestSeq, listLogs } from "../logs.js";

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
    const workstream = opts.workstream ? opts.workstream : await resolveOptionalWorkstream();
    return { source: opts.as, workstream };
  }
  const paneId = process.env.TMUX_PANE;
  if (paneId) {
    const agent = getAgentByPane(db, paneId);
    if (agent) {
      return {
        source: agent.name,
        workstream: opts.workstream ?? agent.workstream,
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
      `seq ${row.seq}  workstream=${row.workstream ?? "—"}  source=${row.source}  kind=${row.kind}`,
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
    emitJson(rows);
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
 *  --tail. 50ms floor prevents a too-low explicit setting from doing
 *  the same. */
function defaultLogTailIntervalMs(): number {
  const raw = process.env.MU_LOG_TAIL_INTERVAL_MS;
  if (raw === undefined) return 1000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 50) return 1000;
  return parsed;
}
