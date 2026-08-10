// mu — herdr substrate (TOPOLOGY half).
//
// Single source of truth for all herdr interactions. Every herdr
// invocation goes through `herdr(args)`, which wraps execa and produces
// structured `HerdrError`s carrying args + the server's JSON error.
//
// ─── The mapping ──────────────────────────────────────────────────────
//
// herdr's own "session" is SERVER-level (one socket per named session),
// so it is NOT the workstream unit. The locked mapping (see
// docs/ARCHITECTURE.md § "Mux session topology") is:
//
//   mu workstream  = herdr WORKSPACE, labelled `mu-<name>`
//   mu window      = herdr TAB
//   mu agent       = herdr PANE
//
// mu addresses workspaces BY LABEL (`MuxSession.name`), because that is
// the only handle mu persists. herdr addresses them by opaque id (`w1`).
// Every session-taking method therefore resolves label → id first; see
// `resolveWorkspaceId`.
//
// ─── Protocol notes ───────────────────────────────────────────────────
//
//   - Every command emits JSON on stdout under `.result`. IDs are READ
//     from creation responses, never predicted or constructed. herdr's
//     skill doc is explicit about this and closed ids are not reused.
//   - `--no-focus` on EVERY mutating call. mu must never steal the
//     user's focus out from under them.
//   - Server errors are JSON on STDERR with exit 1 → `HerdrError`
//     (a `MuxError`, exit 5: the substrate said no).
//   - SYNTAX errors exit 2 → `HerdrSyntaxError`, which is deliberately
//     NOT a `MuxError`. A herdr CLI that renamed a flag under us is a
//     BUG IN MU, and must not masquerade as "herdr is down".
//
// ─── Scope ────────────────────────────────────────────────────────────
//
// This module implements ALL of `MuxBackend` for herdr: sessions,
// windows, panes, pane-id validation, availability, identity, send,
// capture, native pane status, and the two-step spawn
// (`startAgentInPane`).
//
// ─── Two exceptions to "everything is JSON" ───────────────────────────
//
// `herdr status` and `herdr pane read` both emit PLAIN TEXT. They go
// through `currentExecutor` directly rather than `herdr()`, which would
// reject their unparseable stdout as CLI drift.
//
// ─── Why spawn is two steps ───────────────────────────────────────────
//
// herdr has NO create-and-run form: `workspace create` / `tab create` /
// `pane split` always start a plain shell, and `agent start` never
// creates, splits or moves layout — it requires an ALREADY-EXISTING
// pane sitting at its interactive prompt. So the creation verbs below
// REFUSE a non-empty `opts.command` (silently dropping it would leave
// an empty shell mu believes hosts an agent — the worst failure mode),
// and `startAgentInPane` is the second step mu calls afterwards.
// See `MuxBackend.startAgentInPane` for how spawn.ts branches on it.

import { execa } from "execa";
import type { DetectedStatus } from "../detect.js";
import type { NextStep } from "../output.js";
import { sleep } from "./tmux.js";
import {
  type AttachTarget,
  type CaptureOptions,
  type MuxBackend,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxSession,
  type MuxWindow,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  PaneNotFoundError,
  type SendOptions,
  type SendWarning,
  type SplitWindowOptions,
  type StartAgentInPaneOptions,
} from "./types.js";

// ─── Error types ───────────────────────────────────────────────────────

/**
 * "herdr itself failed" — the server returned a JSON error, or the
 * binary could not be reached. A `MuxError`, so `handle()` maps the
 * whole family to exit 5 with one `instanceof`. Mirrors `TmuxError`.
 */
export class HerdrError extends MuxError {
  constructor(
    public readonly args: readonly string[],
    public readonly stderr: string,
    public readonly stdout: string,
    public readonly exitCode: number | null,
    /** herdr's machine-readable error code (e.g. `pane_not_found`), when
     *  the stderr payload parsed as the documented JSON envelope. */
    public readonly code?: string,
  ) {
    const detail = parseErrorEnvelope(stderr)?.message ?? stderr.trim() ?? stdout.trim();
    super(`herdr ${args.join(" ")} failed (exit ${exitCode}): ${detail || "no output"}`);
    this.name = "HerdrError";
  }
  override errorNextSteps(): NextStep[] {
    return [
      { intent: "Run health check", command: "mu doctor" },
      { intent: "Verify the herdr server is running", command: "herdr status" },
      {
        intent: "Check the failing herdr command in isolation",
        command: `herdr ${this.args.join(" ")}`,
      },
    ];
  }
}

/**
 * herdr rejected our ARGUMENTS (exit 2). Deliberately not a `MuxError`:
 * the substrate is healthy and mu asked it something ungrammatical.
 * That is a bug in this file — most likely CLI drift after a herdr
 * upgrade — and must surface as one instead of being swallowed into
 * the "herdr is down" bucket, where it would waste hours.
 */
export class HerdrSyntaxError extends Error {
  override readonly name = "HerdrSyntaxError";
  constructor(
    public readonly args: readonly string[],
    public readonly output: string,
  ) {
    super(
      `herdr rejected the command line (exit 2) — this is a bug in mu, not a herdr outage. ` +
        `Ran: herdr ${args.join(" ")}. herdr said: ${output.trim().split("\n")[0] ?? "(no output)"}`,
    );
  }
}

/**
 * `mu agent spawn --cli <key>` named something herdr does not recognise
 * as an interactive agent kind.
 *
 * A REFUSAL, not a fallback. herdr's `pane run <command>` would happily
 * start the binary, but herdr would then never classify that pane, and
 * on this backend herdr's classification IS mu's status source
 * (`paneStatus()` bypasses src/detect.ts entirely). A pane mu can start
 * but never observe is the same family of failure as a pane mu records
 * with nothing running in it: it looks fine and lies forever.
 *
 * Not a `MuxError`: the substrate is healthy and answered precisely.
 * This is an operator asking for something the active backend cannot
 * do, which `handle()` maps to exit 2 alongside the usage family.
 *
 * herdr is the AUTHORITY on the kind list — mu does not hardcode one,
 * it forwards `--cli` and translates herdr's rejection. A herdr release
 * that adds a kind therefore works without a mu change.
 */
export class HerdrUnsupportedCliError extends Error {
  override readonly name = "HerdrUnsupportedCliError";
  constructor(
    public readonly cli: string,
    public readonly detail: string,
  ) {
    super(
      `herdr does not recognise --cli ${cli} as an interactive agent kind, so it cannot classify that pane's status. herdr said: ${detail}`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "List the agent kinds this herdr knows",
        command: "herdr agent start --help",
      },
      {
        intent: "Spawn with a kind herdr supports",
        command: "mu agent spawn <name> --cli pi -w <workstream>",
      },
      {
        intent: "Or spawn this cli under tmux, which runs any command",
        command: `MU_MUX=tmux mu agent spawn <name> --cli ${this.cli}`,
      },
    ];
  }
}

/**
 * The operator pinned an exact command line — `--command "…"` or
 * `MU_<UPPER_CLI>_COMMAND` — and herdr cannot honour it.
 *
 * `herdr agent start --kind <k>` resolves the canonical executable
 * ITSELF; there is no "use this binary instead" flag. Args after `--`
 * are passed to the agent, NOT used to choose it (verified against
 * 0.8.0: `agent start x --kind pi -- --model m` reports
 * `argv:["pi"]`), so forwarding an override there would append a binary
 * NAME as an argument and start the wrong thing while reporting success.
 *
 * Accepting the override and not honouring it is the one outcome ruled
 * out, so mu refuses and names the variable.
 */
export class HerdrCommandOverrideError extends Error {
  override readonly name = "HerdrCommandOverrideError";
  constructor(
    public readonly cli: string,
    public readonly command: string,
    /** The `MU_<UPPER_CLI>_COMMAND` var, when that is where the override
     *  came from; undefined for an explicit `--command`. */
    public readonly envVar?: string,
  ) {
    super(
      (envVar === undefined
        ? `--command ${JSON.stringify(command)} cannot be honoured on the herdr backend`
        : `${envVar}=${command} cannot be honoured on the herdr backend`) +
        `: 'herdr agent start --kind ${cli}' resolves the executable itself and has no override flag. ` +
        `mu refuses rather than starting a different binary than you asked for.`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      ...(this.envVar === undefined
        ? [
            {
              intent: "Spawn without --command so herdr resolves the agent itself",
              command: `mu agent spawn <name> --cli ${this.cli} -w <workstream>`,
            },
          ]
        : [
            {
              intent: `Unset the override so herdr resolves ${this.cli} itself`,
              command: `unset ${this.envVar}`,
            },
          ]),
      {
        intent: "Or spawn under tmux, which runs the command you name",
        command: `MU_MUX=tmux mu agent spawn <name> --cli ${this.cli}`,
      },
    ];
  }
}

/** A `MuxBackend` method whose herdr implementation is owned by another
 *  task. Never thrown on any path mu currently drives on herdr. */
export class HerdrNotImplementedError extends Error {
  override readonly name = "HerdrNotImplementedError";
  constructor(method: string, owner: string) {
    super(`herdr backend: ${method} is not implemented yet (owned by task ${owner})`);
  }
}

// ─── Pane / workspace / tab ID validation ──────────────────────────────
//
// herdr's public ids are opaque stable handles with a documented shape:
// workspace `w1`, tab `w1:t1`, pane `w1:p1`. Pane ids are workspace-
// qualified, so a pane MOVED between workspaces gets a NEW id — mu must
// re-read it from `.result.move_result.pane.pane_id`, never reuse the old.
//
// This is exactly why `isValidPaneId` is a backend method: a tmux `%15`
// must be rejected here, and a herdr `w1:p1` must be rejected by tmux.
//
// The ORDINALS ARE NOT DECIMAL. Verified on herdr 0.8.0 by opening 38
// panes: the sequence runs `p1 … p9, pA, pB, … pH, pJ, pK, pM, pN, pP …
// pZ, p10, p11 …` — Crockford base32 (digits plus A-Z minus I, L, O, U).
// Workspace and tab ordinals use the same alphabet (`wA` after `w9`).
// A decimal-only pattern therefore works for exactly nine panes and then
// starts rejecting live ids, which on the spawn path is a TypeError on
// the 10th agent in a workstream. Matched as an opaque `[0-9A-Z]+` run
// rather than by spelling out the alphabet: mu's job is to tell a herdr
// id from a tmux one, not to re-derive herdr's numbering.

const HERDR_ORDINAL = "[0-9A-Z]+";
export const PANE_ID_RE = new RegExp(`^w${HERDR_ORDINAL}:p${HERDR_ORDINAL}$`);
const WORKSPACE_ID_RE = new RegExp(`^w${HERDR_ORDINAL}$`);
const TAB_ID_RE = new RegExp(`^w${HERDR_ORDINAL}:t${HERDR_ORDINAL}$`);

export function isValidPaneId(s: string): boolean {
  return PANE_ID_RE.test(s);
}

export function assertValidPaneId(s: string): void {
  if (!isValidPaneId(s)) {
    throw new TypeError(
      `invalid herdr pane id: ${JSON.stringify(s)} (expected ${PANE_ID_RE.source})`,
    );
  }
}

// ─── Executor (swappable for tests) ────────────────────────────────────

export interface HerdrExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type HerdrExecutor = (args: readonly string[]) => Promise<HerdrExecResult>;

/**
 * Optional `--session <name>` prefix spliced in front of every args
 * vector. When `MU_HERDR_SESSION=<name>` is set, mu drives a NAMED
 * herdr server (its own socket under
 * `~/.config/herdr/sessions/<name>/herdr.sock`) instead of the user's
 * default one. Mirrors `MU_TMUX_SOCKET`: it is the isolation seam any
 * integration test must use so the suite can never observe — or
 * destroy — the user's real panes.
 *
 * Read fresh on every call so a setup hook mutating the env mid-run
 * takes effect immediately.
 */
function herdrGlobalFlags(): readonly string[] {
  const session = process.env.MU_HERDR_SESSION;
  if (session === undefined || session.length === 0) return [];
  return ["--session", session];
}

const realExecutor: HerdrExecutor = async (args) => {
  const result = await execa("herdr", [...herdrGlobalFlags(), ...args], { reject: false });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? null,
  };
};

let currentExecutor: HerdrExecutor = realExecutor;

/**
 * Install a custom executor (for tests). Returns the previous executor
 * so tests can restore it cleanly. Production code never calls this.
 * Required: the fast test tier may not shell out.
 */
export function setHerdrExecutor(executor: HerdrExecutor): HerdrExecutor {
  const previous = currentExecutor;
  currentExecutor = executor;
  return previous;
}

/** Restore the real (execa-backed) executor. */
export function resetHerdrExecutor(): void {
  currentExecutor = realExecutor;
}

// ─── JSON envelope ─────────────────────────────────────────────────────

/** herdr's error payload: `{"error":{"code":"…","message":"…"},"id":"…"}`. */
interface HerdrErrorEnvelope {
  code: string;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseErrorEnvelope(stderr: string): HerdrErrorEnvelope | undefined {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const err = parsed.error;
  if (!isRecord(err)) return undefined;
  const code = asString(err.code);
  const message = asString(err.message);
  if (code === undefined) return undefined;
  return { code, message: message ?? code };
}

/**
 * Run a herdr command and return the parsed `.result` object.
 *
 * The single point of contact with the herdr binary; every higher-level
 * operation in this module goes through it.
 *
 * Throws `HerdrSyntaxError` on exit 2 (mu bug), `HerdrError` on any
 * other non-zero exit (substrate failure).
 */
export async function herdr(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await currentExecutor(args);
  if (result.exitCode === 2) {
    throw new HerdrSyntaxError([...args], result.stderr || result.stdout);
  }
  if (result.exitCode !== 0) {
    throw new HerdrError(
      [...args],
      result.stderr,
      result.stdout,
      result.exitCode,
      parseErrorEnvelope(result.stderr)?.code,
    );
  }
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A zero exit with unparseable stdout means the CLI stopped speaking
    // JSON — same class of problem as exit 2, but we cannot prove it is
    // ours, so keep it in the substrate bucket.
    throw new HerdrError([...args], result.stderr, result.stdout, result.exitCode);
  }
  if (!isRecord(parsed)) return {};
  const inner = parsed.result;
  return isRecord(inner) ? inner : {};
}

/** Like `herdr()` but returns undefined instead of throwing when the
 *  server's error code is one of `tolerate`. Used for the idempotent
 *  destructive verbs ("succeeds even if it is already gone"). */
async function herdrTolerating(
  args: readonly string[],
  tolerate: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  try {
    return await herdr(args);
  } catch (err) {
    if (err instanceof HerdrError && err.code !== undefined && tolerate.includes(err.code)) {
      return undefined;
    }
    throw err;
  }
}

// ─── Response shapes ───────────────────────────────────────────────────
//
// Narrow readers over herdr's JSON: they pull only the fields mu uses
// and drop anything malformed, so one odd row never poisons a listing.

interface HerdrWorkspace {
  workspaceId: string;
  label: string;
}

function readWorkspace(v: unknown): HerdrWorkspace | undefined {
  if (!isRecord(v)) return undefined;
  const workspaceId = asString(v.workspace_id);
  if (workspaceId === undefined) return undefined;
  return { workspaceId, label: asString(v.label) ?? "" };
}

function readTab(v: unknown): MuxWindow | undefined {
  if (!isRecord(v)) return undefined;
  const id = asString(v.tab_id);
  if (id === undefined) return undefined;
  // herdr auto-labels a tab with its ordinal ("1"), which is the closest
  // analogue to a tmux window name; mu's `newWindow` sets a real label.
  return { id, name: asString(v.label) ?? "" };
}

function readPane(v: unknown): MuxPane | undefined {
  if (!isRecord(v)) return undefined;
  const paneId = asString(v.pane_id);
  if (paneId === undefined) return undefined;
  return {
    paneId,
    // herdr's optional `label` is what `pane rename` writes and is
    // therefore mu's pane-title equivalent.
    title: asString(v.label) ?? "",
    // herdr does not report a foreground command on `pane list`; the
    // authoritative answer costs a `pane process-info` round trip per
    // pane. Callers that need it use `paneCommand()`.
    command: "",
    windowId: asString(v.tab_id),
  };
}

function readArray(result: Record<string, unknown>, key: string): unknown[] {
  const v = result[key];
  return Array.isArray(v) ? v : [];
}

// ─── Workspaces (= mu sessions) ────────────────────────────────────────

async function listWorkspaces(): Promise<HerdrWorkspace[]> {
  const result = await herdr(["workspace", "list"]);
  const out: HerdrWorkspace[] = [];
  for (const raw of readArray(result, "workspaces")) {
    const ws = readWorkspace(raw);
    if (ws) out.push(ws);
  }
  return out;
}

export async function listSessions(): Promise<MuxSession[]> {
  return (await listWorkspaces()).map((ws) => ({ name: ws.label }));
}

/**
 * Resolve a mu session name (= herdr workspace LABEL) to herdr's opaque
 * workspace id. Returns undefined when no workspace carries that label.
 *
 * Labels are not unique in herdr — an unlabelled `workspace create`
 * defaults the label to the cwd's basename, so a user could plausibly
 * have two. mu only ever creates `mu-<workstream>` labels and refuses
 * duplicate workstream names, so the first match is the right one; the
 * ambiguity is inherent to addressing by label and is why every mutating
 * path resolves once and then works in ids.
 */
async function resolveWorkspaceId(name: string): Promise<string | undefined> {
  for (const ws of await listWorkspaces()) {
    if (ws.label === name) return ws.workspaceId;
  }
  return undefined;
}

/** Resolve or throw. Used by paths where a missing workspace is a real
 *  substrate failure rather than an expected "already gone". */
async function requireWorkspaceId(name: string): Promise<string> {
  const id = await resolveWorkspaceId(name);
  if (id === undefined) {
    throw new HerdrError(
      ["workspace", "list"],
      `{"error":{"code":"workspace_not_found","message":"no herdr workspace labelled ${name}"}}`,
      "",
      1,
      "workspace_not_found",
    );
  }
  return id;
}

export async function sessionExists(name: string): Promise<boolean> {
  return (await resolveWorkspaceId(name)) !== undefined;
}

/**
 * Create a herdr workspace labelled `name`.
 *
 * `opts.detached` is not a knob on herdr: mu ALWAYS passes `--no-focus`,
 * because stealing the user's focus is the one thing a background agent
 * manager must never do. A caller asking for `detached: false` gets a
 * detached workspace anyway; use `workspace focus` explicitly if you
 * really mean to move the user.
 *
 * `opts.windowName` is ignored — herdr names the implicit first tab "1"
 * and mu's window naming happens in `newWindow`.
 */
export async function newSession(name: string, opts: NewSessionOptions = {}): Promise<void> {
  rejectCommand("newSession", opts.command);
  const args = ["workspace", "create", "--label", name, "--no-focus"];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  appendEnvFlags(args, opts.env);
  await herdr(args);
}

/**
 * Create a workspace and return its root pane's id.
 *
 * `opts.command` cannot be honoured here: `workspace create` always
 * starts a plain shell, and running something in it is a `pane run`
 * (the IO surface). Left to `mux-herdr-spawn`.
 */
export async function newSessionWithPane(
  name: string,
  opts: NewSessionWithPaneOptions,
): Promise<string> {
  rejectCommand("newSessionWithPane", opts.command);
  const args = ["workspace", "create", "--label", name, "--no-focus"];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  appendEnvFlags(args, opts.env);
  const result = await herdr(args);
  return readCreatedPaneId(result, "root_pane", args);
}

/** Idempotent: succeeds even if the workspace is already gone. */
export async function killSession(name: string): Promise<void> {
  const id = await resolveWorkspaceId(name);
  if (id === undefined) return;
  await herdrTolerating(["workspace", "close", id], ["workspace_not_found"]);
}

// ─── Tabs (= mu windows) ───────────────────────────────────────────────

export async function listWindows(session?: string): Promise<MuxWindow[]> {
  if (session !== undefined) {
    const id = await resolveWorkspaceId(session);
    // A workspace that vanished mid-reconcile lists as empty, matching
    // the tmux backend's behaviour for a dead session.
    if (id === undefined) return [];
    return readTabs(await herdr(["tab", "list", "--workspace", id]));
  }
  // Cross-workspace: herdr has no `--all`, so fan out and tag each row
  // with the workspace LABEL, which is what MuxWindow.sessionName means.
  const windows: MuxWindow[] = [];
  for (const ws of await listWorkspaces()) {
    for (const tab of readTabs(await herdr(["tab", "list", "--workspace", ws.workspaceId]))) {
      windows.push({ ...tab, sessionName: ws.label });
    }
  }
  return windows;
}

function readTabs(result: Record<string, unknown>): MuxWindow[] {
  const out: MuxWindow[] = [];
  for (const raw of readArray(result, "tabs")) {
    const tab = readTab(raw);
    if (tab) out.push(tab);
  }
  return out;
}

/**
 * Create a tab in `opts.session`'s workspace and return its root pane id.
 * `opts.command` is `mux-herdr-spawn`'s job (see `rejectCommand`).
 */
export async function newWindow(opts: NewWindowOptions): Promise<string> {
  rejectCommand("newWindow", opts.command);
  const args = ["tab", "create"];
  if (opts.session !== undefined) {
    args.push("--workspace", await requireWorkspaceId(opts.session));
  }
  args.push("--label", opts.name, "--no-focus");
  if (opts.cwd) args.push("--cwd", opts.cwd);
  appendEnvFlags(args, opts.env);
  return readCreatedPaneId(await herdr(args), "root_pane", args);
}

/**
 * NO-OP. herdr has no layout-algorithm concept: splits are explicit and
 * geometry is the user's, not mu's. Kept so the contract is total.
 */
export async function selectLayout(_window: string, _layout: string): Promise<void> {
  // Intentionally empty.
}

// ─── Panes (= mu agents) ───────────────────────────────────────────────

/**
 * List every pane in a workspace, addressed by mu session name (= label).
 *
 * Returns `[]` rather than throwing when the workspace is gone: herdr
 * closes a workspace when its last pane exits, so "it was here a moment
 * ago" is normal during reconciliation. Same contract as the tmux backend.
 */
export async function listPanesInSession(session: string): Promise<MuxPane[]> {
  const id = await resolveWorkspaceId(session);
  if (id === undefined) return [];
  const result = await herdrTolerating(
    ["pane", "list", "--workspace", id],
    ["workspace_not_found"],
  );
  if (result === undefined) return [];
  return readPanes(result).map((p) => ({ ...p, sessionName: session }));
}

/**
 * List panes.
 *
 *   - `"*"` or omitted → every pane in every workspace, tagged with its
 *     workspace label. (tmux's default target is "the current session";
 *     herdr has no ambient current workspace outside a managed pane, so
 *     `$HERDR_WORKSPACE_ID` is consulted first and "everything" is the
 *     fallback.)
 *   - a workspace id (`w1`) → that workspace.
 *   - a tab id (`w1:t2`) → that tab's panes.
 *   - a mu session name → that workspace, by label.
 */
export async function listPanes(target?: string): Promise<MuxPane[]> {
  if (target !== undefined && target !== "*") {
    if (TAB_ID_RE.test(target)) {
      const workspaceId = target.split(":")[0] ?? target;
      const panes = readPanes(await herdr(["pane", "list", "--workspace", workspaceId]));
      return panes.filter((p) => p.windowId === target);
    }
    if (WORKSPACE_ID_RE.test(target)) {
      return readPanes(await herdr(["pane", "list", "--workspace", target]));
    }
    return listPanesInSession(target);
  }
  const ambient = process.env.HERDR_WORKSPACE_ID;
  if (target === undefined && ambient !== undefined && WORKSPACE_ID_RE.test(ambient)) {
    return readPanes(await herdr(["pane", "list", "--workspace", ambient]));
  }
  const panes: MuxPane[] = [];
  for (const ws of await listWorkspaces()) {
    for (const pane of readPanes(await herdr(["pane", "list", "--workspace", ws.workspaceId]))) {
      panes.push({ ...pane, sessionName: ws.label });
    }
  }
  return panes;
}

function readPanes(result: Record<string, unknown>): MuxPane[] {
  const out: MuxPane[] = [];
  for (const raw of readArray(result, "panes")) {
    const pane = readPane(raw);
    if (pane) out.push(pane);
  }
  return out;
}

/**
 * Split a pane and return the new pane's id.
 *
 * `opts.horizontal` maps to herdr's `--direction`: horizontal (mu's
 * default, side-by-side) is `right`; a vertical split is `down`.
 * `opts.target` must be a herdr pane id — herdr splits panes, not
 * windows, so there is no ":WindowName" form to accept.
 */
export async function splitWindow(opts: SplitWindowOptions): Promise<string> {
  rejectCommand("splitWindow", opts.command);
  assertValidPaneId(opts.target);
  const args = [
    "pane",
    "split",
    opts.target,
    "--direction",
    opts.horizontal === false ? "down" : "right",
    "--no-focus",
  ];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  appendEnvFlags(args, opts.env);
  return readCreatedPaneId(await herdr(args), "pane", args);
}

/** Idempotent: succeeds even if the pane is already gone. */
export async function killPane(paneId: string): Promise<void> {
  assertValidPaneId(paneId);
  await herdrTolerating(["pane", "close", paneId], ["pane_not_found", "workspace_not_found"]);
}

export async function paneExists(paneId: string): Promise<boolean> {
  if (!isValidPaneId(paneId)) return false;
  const pane = await getPane(paneId);
  return pane !== undefined;
}

/** `pane get`, or undefined when the pane (or its workspace) is gone. */
async function getPane(paneId: string): Promise<MuxPane | undefined> {
  const result = await herdrTolerating(
    ["pane", "get", paneId],
    ["pane_not_found", "workspace_not_found"],
  );
  if (result === undefined) return undefined;
  return readPane(result.pane);
}

/**
 * Look up the TTY device path backing a pane (e.g. `/dev/pts/3`). Used
 * by `mu agent kick` to signal the foreground process group directly.
 *
 * herdr reports the pane's `shell_pid` rather than a TTY, so mu resolves
 * the device through `/proc/<pid>/fd/0`. That is Linux-only by
 * construction; on a kernel without procfs this throws a `HerdrError`
 * naming the limitation rather than returning a plausible-looking lie.
 *
 * Throws `PaneNotFoundError` when the pane has vanished.
 */
export async function paneTTY(paneId: string): Promise<string> {
  assertValidPaneId(paneId);
  const result = await herdrTolerating(
    ["pane", "process-info", "--pane", paneId],
    ["pane_not_found", "workspace_not_found"],
  );
  if (result === undefined) throw new PaneNotFoundError(paneId);
  const info = result.process_info;
  const pid = isRecord(info) ? info.shell_pid : undefined;
  if (typeof pid !== "number") throw new PaneNotFoundError(paneId);
  const { readlink } = await import("node:fs/promises");
  try {
    return await readlink(`/proc/${pid}/fd/0`);
  } catch (err) {
    throw new HerdrError(
      ["pane", "process-info", "--pane", paneId],
      `cannot resolve the TTY for herdr pane ${paneId} (shell pid ${pid}) via /proc: ${String(err)}`,
      "",
      1,
    );
  }
}

// ─── Identity ──────────────────────────────────────────────────────────

/** herdr's pane `label` is mu's pane title. */
export async function setPaneTitle(paneId: string, title: string): Promise<void> {
  assertValidPaneId(paneId);
  await herdr(["pane", "rename", paneId, title]);
}

export async function getPaneTitle(paneId: string): Promise<string | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const pane = await getPane(paneId).catch(() => undefined);
  if (pane === undefined) return undefined;
  return pane.title.length > 0 ? pane.title : undefined;
}

/**
 * The agent name of the pane this process is running in, read from the
 * `$HERDR_PANE_ID` that herdr injects into every managed pane.
 *
 * Fallback rung only: `$MU_AGENT_NAME` is checked first by
 * `src/tasks/claim.ts` and is backend-independent. Titles are composed
 * as `name · <glyph> · task_id`, so the name is the first token.
 */
export async function currentAgentName(): Promise<string | undefined> {
  const paneId = process.env.HERDR_PANE_ID;
  if (paneId === undefined || !isValidPaneId(paneId)) return undefined;
  const title = await getPaneTitle(paneId);
  if (title === undefined) return undefined;
  const idx = title.indexOf(" · ");
  return idx === -1 ? title.trim() : title.slice(0, idx).trim();
}

/**
 * Label of the workspace the CALLER is running inside, or undefined
 * outside a managed pane. Backs the `mu-<name>` rung of workstream
 * auto-detection.
 *
 * herdr injects `$HERDR_WORKSPACE_ID` into every pane it manages, so
 * this is one lookup rather than tmux's `display-message -p '#S'`. The
 * env var carries the opaque id; mu keys on the LABEL, so resolve it.
 */
export async function currentSessionName(): Promise<string | undefined> {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (workspaceId === undefined || !WORKSPACE_ID_RE.test(workspaceId)) return undefined;
  for (const ws of await listWorkspaces()) {
    if (ws.workspaceId === workspaceId) return ws.label;
  }
  return undefined;
}

// ─── IO ────────────────────────────────────────────────────────────────
//
// THE SEND PROTOCOL IS ONE CALL. Read the header of ./tmux.ts for what
// that replaces: six steps, of which THREE (awaitPaneQuiescence,
// the MU_SEND_DELAY_MS gap, and the confirm-the-Enter-took retry loop)
// exist purely because a TUI rendering a modal SWALLOWS a `send-keys
// Enter`, stranding the pasted text while `mu agent send` reports exit 0
// (dogfood_send_after_new_dropped).
//
// `herdr agent prompt` submits the text AND an encoded Enter atomically,
// honouring the pane's live bracketed-paste mode, so the Enter cannot be
// separated from the paste and cannot be swallowed. There is nothing
// left for a quiescence poll to protect against — porting one here would
// re-add latency to work around a bug this substrate does not have.
//
// Do not add a scrollback poll to this file. If a send ever looks
// unconfirmed on herdr, that is a herdr bug, and the `agent_prompt_
// stalled` guard below is how it surfaces.

// ─── Spawn, step 2 ─────────────────────────────────────────────────────
//
// The creation verbs above make a BARE pane; this turns it into a running
// agent. Both halves exist because herdr has no create-and-run form.

/**
 * Retry budget for `agent start` while herdr reports the target pane is
 * not yet an available shell.
 *
 * VERIFIED RACE (0.8.0): `agent start` immediately after `pane split`
 * fails `agent_pane_busy` ~100% of the time; with a 200ms gap it
 * succeeded every time. The pane exists the moment split returns, but its
 * shell has not drawn a prompt yet, and `agent start` requires an
 * interactive prompt with nothing in the foreground.
 *
 * A retry rather than a fixed pre-sleep: the condition is observable, so
 * mu polls instead of guessing a constant that is simultaneously too long
 * for a fast box and too short for a loaded one. ~3s nominal, because
 * losing the race means a rolled-back spawn while a pane that never frees
 * up is a real failure and must not be spun on forever. Counted in
 * ATTEMPTS not wall-clock, so `setSleepForTests` alone makes the loop
 * instant and deterministic in the fast tier.
 */
const PANE_READY_RETRY_INTERVAL_MS = 50;
const PANE_READY_MAX_ATTEMPTS = 60;

/**
 * Turn an existing bare pane into a running agent, and return only once
 * herdr considers that agent ready for input.
 *
 * `herdr agent start <name> --kind <cli> --pane <id>` blocks until herdr
 * has DETECTED the expected agent in that terminal and it is
 * interactive-ready (30s default timeout, herdr's own). That subsumes
 * mu's tmux-side `awaitSpawnLiveness` + `awaitSpawnReadiness` scrollback
 * polling completely, which is why `src/agents/spawn.ts` skips both when
 * a backend implements this method. Nothing here re-implements them.
 *
 * Three refusals, all deliberate (see each error class):
 *   - an operator-pinned command      → `HerdrCommandOverrideError`
 *   - a `--cli` herdr does not know   → `HerdrUnsupportedCliError`
 *   - an agent name herdr rejects     → the raw `HerdrError`
 * On any of them nothing has started, and the caller's rollback kills the
 * bare pane. No path leaves mu holding an agent row for a pane with
 * nothing running in it.
 *
 * Addressed BY PANE ID: the herdr-level agent NAME is cleared when the
 * occupant exits, so the pane id is the only durable handle (and the
 * only one mu persists). Matching `sendToPane`'s choice.
 */
export async function startAgentInPane(opts: StartAgentInPaneOptions): Promise<void> {
  assertValidPaneId(opts.paneId);
  // Refuse BEFORE touching the server: an override we cannot honour is
  // decidable locally, and failing fast keeps the pane pristine for the
  // caller's rollback.
  if (opts.commandSource !== "cli-key") {
    throw new HerdrCommandOverrideError(
      opts.cli,
      opts.command,
      // Name the env var only when that is actually where the override
      // came from; "unset MU_PI_COMMAND" is useless advice to someone who
      // typed --command.
      opts.commandSource === "env" ? envVarNameForCli(opts.cli) : undefined,
    );
  }
  const args = ["agent", "start", opts.name, "--kind", opts.cli, "--pane", opts.paneId];
  for (let attempt = 1; ; attempt += 1) {
    try {
      await herdr(args);
      return;
    } catch (err) {
      // An unknown --kind is a SYNTAX error to herdr's arg parser (exit
      // 2), because `--kind` is a closed enum. Everywhere else exit 2
      // means mu drifted from the CLI, so translate it here — an
      // operator typo must not read as "bug in mu".
      if (err instanceof HerdrSyntaxError) {
        throw new HerdrUnsupportedCliError(opts.cli, err.output.trim().split("\n")[0] ?? "");
      }
      const busy = err instanceof HerdrError && err.code === "agent_pane_busy";
      if (!busy || attempt >= PANE_READY_MAX_ATTEMPTS) throw err;
      await sleep(PANE_READY_RETRY_INTERVAL_MS);
    }
  }
}

/**
 * `MU_<UPPER_CLI>_COMMAND`, mirroring `envVarNameForCli` in
 * src/agents/spawn.ts. Duplicated rather than imported because the mux
 * cluster may not depend on the agent layer (imports run cluster →
 * root, never sideways into another feature); it is one string join and
 * `test/mux-herdr-spawn.test.ts` asserts the two stay identical.
 */
function envVarNameForCli(cli: string): string {
  return `MU_${cli.toUpperCase().replace(/-/g, "_")}_COMMAND`;
}

// ─── IO (owned by mux-herdr-io) ────────────────────────────────────────

/** herdr's error code for "submitted, but the agent's lifecycle never
 *  moved within its 5s guard". Not an outage — a suspicious send. */
const PROMPT_STALLED_CODE = "agent_prompt_stalled";

/** Codes meaning "the pane hosts no RECOGNIZED agent", so the `agent`
 *  surface cannot address it and we fall back to the `pane` surface. */
const NO_AGENT_CODES: readonly string[] = ["agent_not_found", "agent_not_recognized"];

/** Default handler for an unconfirmed send: warn on stderr. Loud by
 *  design, exactly as on tmux — silence is the failure mode. */
function defaultUndeliveredWarning(warning: SendWarning): void {
  console.warn(`warning: ${warning.message}`);
}

/**
 * Submit `text` to a pane and press Enter, atomically.
 *
 * WHICH SURFACE (topology note 9): `agent prompt` only accepts targets
 * herdr has RECOGNIZED as an agent — a plain shell pane is
 * `agent_not_found` there. mu therefore tries the agent surface FIRST
 * (the overwhelmingly common case: every mu-managed pane runs a coding
 * CLI, and it is the only surface that understands lifecycle state) and
 * falls back to `pane run`, herdr's atomic text+Enter for raw shells,
 * only when herdr says there is no agent. The happy path is one call;
 * the fallback path is two, and never polls.
 *
 * `opts.readinessMs === 0` drops `--wait`, the herdr analogue of tmux's
 * "bare protocol" opt-out: submit and return without waiting for a
 * settled state. Any other value is ignored — there is no readiness to
 * budget for. `opts.delayMs` is likewise meaningless here: the gap it
 * sizes does not exist. Neither is an error; the tmux-shaped knobs stay
 * accepted so callers need no backend branch.
 *
 * No `--until`: `--wait` already defaults to the first settled idle /
 * done / blocked, which is precisely what mu's callers want, and herdr's
 * skill doc calls repeating those defaults a bug.
 *
 * DELIVERY CONTRACT, same as tmux: an unconfirmed send WARNS and keeps
 * going, never throws. herdr returns `agent_prompt_stalled` when a
 * prompt from a non-working state produces no lifecycle change within
 * 5s — the same observable as tmux's stranded paste, so it maps onto the
 * existing `paste-vanished` reason: the pane was calm, we submitted, and
 * nothing happened.
 */
export async function sendToPane(
  paneId: string,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  assertValidPaneId(paneId);
  const wait = opts.readinessMs === 0 ? [] : ["--wait"];
  try {
    await herdr(["agent", "prompt", paneId, text, ...wait]);
    return;
  } catch (err) {
    if (!(err instanceof HerdrError) || err.code === undefined) throw err;
    if (err.code === PROMPT_STALLED_CODE) {
      const warn = opts.onUndelivered ?? defaultUndeliveredWarning;
      warn({
        paneId,
        reason: "paste-vanished",
        message: `send to ${paneId} was submitted but the agent's state never changed (herdr: ${PROMPT_STALLED_CODE}). The agent may NOT have seen it. Read the pane, or re-send.`,
      });
      return;
    }
    if (!NO_AGENT_CODES.includes(err.code)) throw err;
  }
  // No recognized agent in this pane: raw shell. `pane run` is herdr's
  // atomic text+Enter for that case. It has no lifecycle to wait on, so
  // there is nothing to confirm and nothing to warn about.
  await herdr(["pane", "run", paneId, text]);
}

/**
 * Read pane output as plain text.
 *
 *   - no options → everything herdr has available, soft wraps joined
 *   - `lines: 0`  → the rendered viewport only (`--source visible`)
 *   - `lines: N`  → the last N rows, soft wraps joined
 *
 * `recent-unwrapped` is the source herdr recommends for logs and
 * transcripts: it joins soft wraps, so a wrapped line reads as one line
 * rather than as terminal-width fragments.
 *
 * KNOWN LIMIT — do not paper over this: a pane running its agent on the
 * terminal's ALTERNATE screen does not spill rows into herdr's host
 * scrollback. Rows that have left the alternate screen are GONE, so a
 * bigger `--lines` cannot recover them. If a read looks truncated, that
 * is why, and the fix is to ask the agent to write its output to a file
 * — not to raise the line count.
 *
 * `pane read` emits PLAIN TEXT, so it bypasses `herdr()` (which would
 * treat unparseable stdout as CLI drift) and reads the executor result
 * directly, mapping herdr's JSON error envelope by hand.
 */
export async function capturePane(paneId: string, opts: CaptureOptions = {}): Promise<string> {
  assertValidPaneId(paneId);
  const args = ["pane", "read", paneId];
  if (opts.lines === 0) {
    args.push("--source", "visible");
  } else {
    args.push("--source", "recent-unwrapped");
    if (opts.lines !== undefined) args.push("--lines", String(opts.lines));
  }
  const result = await currentExecutor(args);
  if (result.exitCode === 2) throw new HerdrSyntaxError(args, result.stderr || result.stdout);
  if (result.exitCode !== 0) {
    throw new HerdrError(
      args,
      result.stderr,
      result.stdout,
      result.exitCode,
      parseErrorEnvelope(result.stderr)?.code,
    );
  }
  return result.stdout;
}

// ─── Native status ─────────────────────────────────────────────────────

/**
 * herdr's five agent lifecycle states, mapped onto mu's.
 *
 *   working → busy
 *   blocked → needs_permission   (herdr recognized an approval/question UI)
 *   idle    → needs_input
 *   done    → needs_input
 *   unknown → needs_input
 *
 * `unknown` MUST NOT become `free`. herdr's skill doc is explicit that
 * unknown "does not prove completion"; a false `free` makes mu hand the
 * worker a second task while the first is still running. `needs_input`
 * is the safe reading of "an agent is there and we cannot classify it".
 * (`free` is not a detected status at all — it is set by `mu agent
 * free`, i.e. by the user, and no detector may mint it.)
 *
 * `done` is herdr's idle-after-UNSEEN-background-work, and CLI reads
 * deliberately do NOT mark a tab seen. mu polling therefore never clears
 * the user's done badge — which is the point, and why nothing in this
 * file calls a focus or seen-marking verb.
 */
export function mapAgentStatus(agentStatus: string): DetectedStatus {
  switch (agentStatus) {
    case "working":
      return "busy";
    case "blocked":
      return "needs_permission";
    default:
      // idle / done / unknown, and any state a future herdr adds: the
      // conservative reading is "waiting on a human", never "free".
      return "needs_input";
  }
}

/**
 * The pane's status as HERDR classifies it, or undefined when the pane
 * is gone (or reports no state at all).
 *
 * This is why `src/detect.ts` — the scrollback-scraping PI STATUS
 * DETECTOR — is bypassed on this backend. herdr watches the terminal
 * continuously across every agent kind it knows; mu guessing from a
 * 100-line tail would be strictly worse information, and would
 * misclassify every non-pi CLI. See docs/ARCHITECTURE.md § "Status
 * detection is backend-dependent".
 */
export async function paneStatus(paneId: string): Promise<DetectedStatus | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const result = await herdrTolerating(
    ["pane", "get", paneId],
    ["pane_not_found", "workspace_not_found"],
  );
  if (result === undefined) return undefined;
  const pane = result.pane;
  const status = isRecord(pane) ? asString(pane.agent_status) : undefined;
  if (status === undefined) return undefined;
  return mapAgentStatus(status);
}

// ─── Chrome ────────────────────────────────────────────────────────────

/**
 * NO-OP. herdr owns its own pane chrome and exposes no border knobs;
 * mu-managed panes are distinguished by their label instead. Returns 0
 * (windows decorated) to keep the contract total.
 */
export async function enableMuPaneBordersForSession(_session: string): Promise<number> {
  return 0;
}

/** NO-OP. See `enableMuPaneBordersForSession`. */
export async function enableMuPaneBordersForPane(_paneId: string): Promise<void> {
  // Intentionally empty.
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Push one `--env KEY=VALUE` flag per entry. Keys must be non-empty and
 * free of `=`; throwing a TypeError keeps the failure at the call site
 * instead of letting herdr reject the line as a syntax error (exit 2),
 * which would look like CLI drift.
 */
function appendEnvFlags(args: string[], env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const [k, v] of Object.entries(env)) {
    if (k.length === 0) throw new TypeError("herdr env key must be non-empty");
    if (k.includes("=")) {
      throw new TypeError(`herdr env key must not contain '=': ${JSON.stringify(k)}`);
    }
    args.push("--env", `${k}=${v}`);
  }
}

/**
 * herdr's creation verbs start a plain shell; there is no
 * create-and-run-this form. Running the agent CLI in the new pane is a
 * separate `pane run` / `agent start` step, which is `mux-herdr-spawn`.
 * Refuse loudly rather than silently dropping the command on the floor.
 */
function rejectCommand(method: string, command: string | undefined): void {
  if (command === undefined || command.trim().length === 0) return;
  throw new HerdrNotImplementedError(`${method} with a command`, "mux-herdr-spawn");
}

/**
 * Read a pane id out of a creation response. Never predict an id: herdr
 * does not reuse closed ids and a moved pane is renumbered, so the
 * response is the only trustworthy source.
 */
function readCreatedPaneId(
  result: Record<string, unknown>,
  key: string,
  args: readonly string[],
): string {
  const pane = readPane(result[key]);
  if (pane === undefined) {
    throw new HerdrError(
      args,
      `herdr response had no ${key}.pane_id: ${JSON.stringify(result)}`,
      "",
      0,
    );
  }
  assertValidPaneId(pane.paneId);
  return pane.paneId;
}

// ─── Backend record ────────────────────────────────────────────────────

/**
 * True iff herdr can be reached right now. `herdr status` rather than a
 * PATH probe, and it must report a RUNNING, COMPATIBLE server: a herdr
 * binary whose server is down (or speaks a different protocol version)
 * cannot drive a single pane, so it is not an available backend.
 *
 * Note `herdr status` is plain text, not JSON — the one exception to the
 * "everything is JSON" rule, so it is parsed here rather than through
 * `herdr()`.
 */
async function herdrAvailable(): Promise<boolean> {
  const result = await currentExecutor(["status"]).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return false;
  if (!/^\s*status:\s*running\s*$/m.test(result.stdout)) return false;
  // `compatible:` is only printed when a server is running; treat an
  // explicit "no" as unavailable and a missing line as fine.
  return !/^\s*compatible:\s*no\s*$/m.test(result.stdout);
}

// ─── Attach ─────────────────────────────────────────────────────────────
//
// herdr addresses attach targets by opaque id, not by name, so both
// shapes below resolve the mu session name (= workspace label) to a
// workspace id first. Resolution is async but `attachHint` /
// `attachCommands` are sync by contract, so they emit a `workspace
// focus` against the LABEL-resolved id when one is known and fall back
// to the session-attach form otherwise. Callers that need the resolved
// id already awaited `currentSessionName` / `sessionExists`.

/**
 * Copy-pasteable line landing the user on `target`.
 *
 * Unlike tmux there is no "attach vs switch-client" split: a herdr
 * client is already attached to the server, and focusing a workspace
 * works identically from inside and outside a managed pane. `inside`
 * is therefore ignored, which is legitimate — the flag reports ambient
 * evidence and lets each backend decide what it means.
 */
export function attachHint(target: AttachTarget): string {
  if (target.window !== undefined) {
    return `herdr session attach ${target.session} # then focus tab ${target.window}`;
  }
  return `herdr session attach ${target.session}`;
}

export function attachCommands(target: AttachTarget): readonly MuxCommand[] {
  return [{ command: "herdr", args: ["session", "attach", target.session] }];
}

// ─── Diagnostics ────────────────────────────────────────────────────────

export function paneNotFoundNextSteps(paneId: string): NextStep[] {
  return [
    {
      intent: `Verify the pane id ${paneId} actually exists`,
      command: `herdr pane get ${paneId}`,
    },
    {
      intent: "List panes in the current workspace",
      command: 'herdr pane list --workspace "$HERDR_WORKSPACE_ID"',
    },
  ];
}

/**
 * Version probe plus the ambient facts herdr injects into every managed
 * pane. Returns DATA; `mu doctor` owns the strings.
 *
 * `herdr status` is the one command that is NOT JSON (see the task note
 * on mux-herdr-topology), so this parses the plain-text `version:` line
 * from the CLIENT block rather than routing through `herdr()`.
 */
export async function healthCheck(): Promise<MuxHealth> {
  let version: string | null = null;
  try {
    const result = await currentExecutor(["status"]);
    if (result.exitCode === 0) {
      const match = /^\s*version:\s*(\S+)\s*$/m.exec(result.stdout);
      version = match?.[1] ?? null;
    }
  } catch {
    version = null;
  }
  return {
    name: "herdr",
    ok: version !== null,
    version,
    env: [
      { name: "$HERDR_ENV", value: process.env.HERDR_ENV ?? null },
      { name: "$HERDR_WORKSPACE_ID", value: process.env.HERDR_WORKSPACE_ID ?? null },
      { name: "$HERDR_PANE_ID", value: process.env.HERDR_PANE_ID ?? null },
    ],
    remediation: "start the herdr server (herdr status) or install herdr",
  };
}

/**
 * The herdr implementation of `MuxBackend`. A frozen record of the
 * module's functions — no state of its own, so swapping backends is a
 * pointer assignment (see ./detect.ts).
 */
export const herdrBackend: MuxBackend = Object.freeze({
  name: "herdr" as const,
  available: herdrAvailable,

  isValidPaneId,
  assertValidPaneId,

  listSessions,
  sessionExists,
  newSession,
  newSessionWithPane,
  killSession,

  listWindows,
  newWindow,
  selectLayout,

  listPanes,
  listPanesInSession,
  splitWindow,
  killPane,
  paneExists,
  paneTTY,

  setPaneTitle,
  getPaneTitle,
  currentAgentName,
  currentSessionName,

  startAgentInPane,

  sendToPane,
  capturePane,
  paneStatus,

  enableMuPaneBordersForSession,
  enableMuPaneBordersForPane,

  attachHint,
  attachCommands,
  paneNotFoundNextSteps,
  healthCheck,
});
