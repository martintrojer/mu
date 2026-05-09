// mu — adoptAgent: register an existing tmux pane as a managed agent.
//
// The inverse of `mu agent spawn` — instead of creating the pane,
// adoptAgent hooks an already-existing pane into mu's registry.
//
// Two flavours of resolution:
//   - by paneId   ('%15')         : look up directly via tmux
//   - by paneTitle ('worker-1')   : scan tmux panes for matching title
//
// Common cases for adopt:
//   - operator manually started a CLI in a pane before installing mu
//   - mu agent close was followed by re-attaching the pane via tmux
//   - migrating from a previous orchestrator
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import {
  type AgentRow,
  getAgent,
  getAgentByPane,
  insertAgent,
  isValidAgentName,
} from "../agents.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import {
  PaneNotFoundError,
  type TmuxPane,
  listPanesInSession,
  paneExists,
  parseAgentNameFromTitle,
  setPaneTitle,
} from "../tmux.js";
import { AgentExistsError, AgentNotInWorkstreamError } from "./errors.js";

export interface AdoptAgentOptions {
  /** tmux pane id (e.g. '%15'). Must already exist on the tmux server. */
  paneId: string;
  /** Workstream to adopt the pane into. The pane MUST be in the
   *  matching tmux session (`mu-<workstream>`); cross-session adopt is
   *  rejected. */
  workstream: string;
  /** Override the pane's title with this name. When omitted, the pane's
   *  current title becomes the agent name (zero-config adoption). */
  name?: string;
  /** Defaults to 'pi' via the schema DEFAULT. */
  cli?: string;
  /** 'full-access' (default) or 'read-only'. */
  role?: string;
  /** Override the tmux session lookup. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
}

export interface AdoptAgentResult {
  agent: AgentRow;
  /** True when the pane already had a matching agents row — the call
   *  was a no-op (idempotent). */
  alreadyAdopted: boolean;
  /** The pane title before adopt, or null if the pane had no title. */
  previousTitle: string | null;
  /** The title the pane was set to (== agent.name post-adopt). Equal to
   *  previousTitle when no retitle happened. */
  paneTitleSetTo: string;
}

/**
 * Register an existing tmux pane as a managed mu agent. Inverse of the
 * 'orphan' state surfaced by `mu agent list`: a pane that looks like an
 * agent (running pi/claude/codex) but has no DB row.
 *
 * Identity contract (matches the claim protocol invariant):
 *   - Post-adopt, the pane's title equals the agent's name.
 *   - When `name` is omitted, the pane's existing title becomes the
 *     agent name verbatim. Adopting a pane titled 'pi' would fail name
 *     validation — caller must supply --name in that case.
 *
 * Idempotent: adopting the same pane twice with the same name is a
 * no-op (returns alreadyAdopted=true). Adopting a different pane under
 * an existing agent name throws AgentExistsError.
 *
 * Validation order (matches the design in note #100):
 *   1. Pane id format     -> assertValidPaneId via paneExists / setPaneTitle
 *   2. Pane exists        -> PaneNotFoundError
 *   3. Pane is in session -> AgentNotInWorkstreamError (cross-session)
 *   4. Resolved name OK   -> isValidAgentName / Error('agent name invalid')
 *   5. Idempotent check   -> if pane already owned by an agent of this
 *                            name, return alreadyAdopted=true
 *   6. Name not taken     -> AgentExistsError (else)
 *   7. Insert + retitle.
 *
 * Status starts at 'free' — reconcile/detect will update it on the next
 * `mu agent list` based on actual pane content (the pi prompt yields
 * 'free'; an agent mid-thought yields 'busy'; etc.). We don't run
 * detection inline here because the caller may not have $TMUX, and
 * adoption shouldn't depend on a captured-pane probe succeeding.
 */
export async function adoptAgent(db: Db, opts: AdoptAgentOptions): Promise<AdoptAgentResult> {
  // Step 1+2: pane format + existence.
  if (!(await paneExists(opts.paneId))) {
    throw new PaneNotFoundError(opts.paneId);
  }

  // Step 3: pane must be in the workstream's tmux session.
  const expectedSession = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const panesInSession: TmuxPane[] = await listPanesInSession(expectedSession);
  const matchingPane = panesInSession.find((p) => p.paneId === opts.paneId);
  if (!matchingPane) {
    // Pane exists (passed step 2) but isn't in the expected session.
    // Synthesise the cross-session error using the same shape as the
    // existing AgentNotInWorkstreamError path so the CLI's exit-code
    // mapping handles it identically. We don't know the actual session
    // name without another tmux query; the message just says 'a
    // different session' — actionable enough.
    throw new AgentNotInWorkstreamError(
      `pane ${opts.paneId}`,
      opts.workstream,
      "a different tmux session",
    );
  }

  // Step 4: resolved name. Default to the pane's current title —
  // unwrapping a possibly-composed mu title ('name · <STATUS_EMOJI> · task')
  // back to just the name token. Re-adoption of a pane that mu previously
  // owned must work; without parseAgentNameFromTitle the ' · <glyph>'
  // suffix would fail isValidAgentName.
  const previousTitle = matchingPane.title.length > 0 ? matchingPane.title : null;
  const candidate =
    opts.name ?? (previousTitle !== null ? parseAgentNameFromTitle(previousTitle) : "");
  const resolvedName = candidate;
  if (!isValidAgentName(resolvedName)) {
    if (opts.name === undefined) {
      throw new Error(
        `pane ${opts.paneId} title '${previousTitle ?? "(empty)"}' is not a valid agent name; pass --name <name>`,
      );
    }
    throw new Error(`agent name invalid: '${resolvedName}'`);
  }

  // Step 5: idempotency. If an agent already owns this pane id, check
  // whether it's the same name; same name == no-op, different name ==
  // conflict (we don't move agents between pane ids silently).
  const existingByPane = getAgentByPane(db, opts.paneId);
  if (existingByPane) {
    if (existingByPane.name === resolvedName) {
      return {
        agent: existingByPane,
        alreadyAdopted: true,
        previousTitle,
        paneTitleSetTo: resolvedName,
      };
    }
    throw new AgentExistsError(existingByPane.name);
  }

  // Step 6: name not taken (in any workstream — agents.name is the PK).
  const existingByName = getAgent(db, resolvedName);
  if (existingByName) {
    throw new AgentExistsError(resolvedName);
  }

  // Step 7: insert + (conditional) retitle.
  const inserted = insertAgent(db, {
    name: resolvedName,
    workstream: opts.workstream,
    paneId: opts.paneId,
    status: "free",
    cli: opts.cli,
    role: opts.role,
  });
  if (resolvedName !== previousTitle) {
    await setPaneTitle(opts.paneId, resolvedName);
  }
  emitEvent(
    db,
    opts.workstream,
    `agent adopt ${resolvedName} (pane ${opts.paneId}, was title='${previousTitle ?? ""}')`,
  );
  return {
    agent: inserted,
    alreadyAdopted: false,
    previousTitle,
    paneTitleSetTo: resolvedName,
  };
}
