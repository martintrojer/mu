// mu — the **op context** SDK seam (docs/VOCABULARY.md § op context).
//
// Triggers capture reliably but blindly: they see a row change, not why
// it happened. Intent, grouping and actor are recovered by having the
// SDK write them into the per-connection `_op_ctx` temp table, which the
// triggers read as they stamp each op.
//
// ONE ASSIGNMENT PER PUBLIC SDK FUNCTION, not an emit per mutation.
// That is the whole reason this is cheap enough to apply everywhere: a
// cascade close touching 12 tasks sets the context once and gets 12
// correctly-labelled, correctly-grouped ops for free.
//
// WHY A SCOPED WRAPPER RATHER THAN A SETTER
// -----------------------------------------
// The obvious alternative is `setOpContext(db, {...})` called at the top
// of each SDK function. It was rejected: it leaks. Whatever intent was
// set last stays set for the rest of the process, so the NEXT mutation
// — possibly in a caller that never set a context, possibly in a
// finally-block cleanup after a throw — gets mislabelled with a stale
// intent. A wrong intent is worse than a null one, because `mu log`
// renders it as confident prose and undo groups by it.
//
// `withOpContext(db, {...}, fn)` restores the previous context in a
// `finally`, so:
//   * a throw inside fn cannot leak the intent (tested),
//   * nesting is predictable — an inner context wins while it runs and
//     the outer one is exactly restored after,
//   * the context's lifetime is visible in the source as a block.
//
// Nested calls inherit the OUTER group by default, which is what makes
// grouping work without any caller threading a group id around:
// `closeTask` opening a group and calling `setTaskStatus` per cascaded
// child yields one group covering all of them. An inner call that wants
// its own group passes `group: "new"`.

import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

/** What an op context carries. All fields optional — a partial context
 *  is fine and a null intent is captured as null (fail safe). */
export interface OpContext {
  /** Semantic label, e.g. `task.close`. Human-grade: `mu log` renders
   *  prose from it. Use `<entity>.<verb>` with entities from
   *  docs/VOCABULARY.md. */
  intent?: string | undefined;
  /**
   * Intent to use ONLY when no enclosing context already set one.
   *
   * For shared internals that several public verbs funnel through.
   * `setTaskStatus` is the motivating case: called directly it is the
   * operator's action and should label itself, but called from
   * `closeTask` the OUTER verb is the operator-meaningful label and
   * must win. Without this, the inner call would report the mechanism
   * instead of the intent.
   *
   * Ignored when `intent` is also provided.
   */
  intentIfUnset?: string | undefined;
  /** Who caused it. Free text, same semantics as the old
   *  `agent_logs.source`: an agent name, "user", "system". */
  actor?: string | undefined;
  /**
   * Grouping for `mu undo`:
   *   - omitted   inherit the enclosing group, or start one if none.
   *   - "new"     force a fresh group even when nested.
   *   - <string>  use this exact group id.
   */
  group?: string | "new" | undefined;
}

interface CtxRow {
  group_id: string | null;
  actor: string | null;
  intent: string | null;
  applying: number;
}

/** Read the current context. Exported for tests and for `mu doctor`. */
export function currentOpContext(db: Db): {
  groupId: string | null;
  actor: string | null;
  intent: string | null;
  applying: boolean;
} {
  const row = db.prepare("SELECT group_id, actor, intent, applying FROM _op_ctx").get() as
    | CtxRow
    | undefined;
  // No row => this connection never ran installCapture (a readonly
  // open). Report the inert default rather than throwing: callers use
  // this for diagnostics, and a missing context is not an error.
  if (!row) return { groupId: null, actor: null, intent: null, applying: false };
  return {
    groupId: row.group_id,
    actor: row.actor,
    intent: row.intent,
    applying: row.applying !== 0,
  };
}

function writeCtx(db: Db, row: CtxRow): void {
  db.prepare(
    `UPDATE _op_ctx SET group_id = @group_id, actor = @actor,
                        intent = @intent, applying = @applying`,
  ).run(row);
}

function readCtx(db: Db): CtxRow | undefined {
  return db.prepare("SELECT group_id, actor, intent, applying FROM _op_ctx").get() as
    | CtxRow
    | undefined;
}

/**
 * Run `fn` with the given op context applied, restoring the previous
 * context afterwards even if `fn` throws.
 *
 * Synchronous by design. Every mutating mu SDK function is synchronous
 * (better-sqlite3 is), so an async variant would only invite
 * interleaving two contexts on one connection — the temp table is
 * shared per-connection, so two concurrent async scopes would clobber
 * each other with no way to tell whose intent won. Keeping this sync
 * makes that unrepresentable.
 */
export function withOpContext<T>(db: Db, ctx: OpContext, fn: () => T): T {
  const previous = readCtx(db);
  if (!previous) {
    // No _op_ctx table on this connection (readonly open, or a DB
    // opened before capture existed). Nothing to stamp and nothing to
    // restore; run the body so behaviour degrades to "captured with no
    // context" rather than throwing.
    return fn();
  }

  const groupId =
    ctx.group === "new"
      ? randomUUID()
      : ctx.group !== undefined
        ? ctx.group
        : (previous.group_id ?? randomUUID());

  const intent =
    ctx.intent !== undefined ? ctx.intent : (previous.intent ?? ctx.intentIfUnset ?? null);

  writeCtx(db, {
    group_id: groupId,
    // An explicit undefined inherits; only a provided value overrides.
    actor: ctx.actor !== undefined ? ctx.actor : previous.actor,
    intent,
    applying: previous.applying,
  });
  try {
    return fn();
  } finally {
    writeCtx(db, previous);
  }
}

/**
 * Run `fn` with capture SUPPRESSED — the echo guard.
 *
 * Applying a peer's op writes to `tasks`, which fires the capture
 * trigger, which mints a NEW local op, which flushes to our segment and
 * propagates back to the peer, which applies it and echoes again. This
 * sets `applying = 1` so every trigger's `WHEN` clause short-circuits
 * and the ingest writes rows WITHOUT writing ops.
 *
 * v2-sync wraps its ingest loop in this. It lives here rather than in
 * the sync module because the flag is part of the op-context contract
 * the triggers read, and having exactly one writer of it is the point.
 *
 * Restores the previous value in a `finally`, so a throw mid-ingest
 * cannot leave capture permanently disabled on this connection — which
 * would be the worst possible failure mode, silently dropping every
 * subsequent local change.
 */
export function withCaptureSuppressed<T>(db: Db, fn: () => T): T {
  const previous = readCtx(db);
  if (!previous) return fn();
  writeCtx(db, { ...previous, applying: 1 });
  try {
    return fn();
  } finally {
    writeCtx(db, previous);
  }
}
