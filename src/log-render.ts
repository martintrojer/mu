// mu — the ONE op → prose formatter.
//
// WHY THIS FILE EXISTS
//
// mu once rendered log lines by prefix-matching free prose: `classifyEventVerb`
// walked `EVENT_VERB_PREFIXES` looking for a leading two-word verb, and
// `CLAIM_EVENT_PREFIX` was bolted on because that matching kept breaking
// (review_code_last_claim_actor_brittle). Rewording any payload silently
// broke its renderer, and attribution had to be smuggled through a
// tab-delimited prefix so it could be parsed back out.
//
// Since v2-capture + v2-retire-log-shim, every op carries a structured
// `intent` ('task.close'), a natural `key` ('demo/t1'), and a JSON
// payload holding ONLY the columns that changed. So rendering is a
// lookup on intent, not a search through text. THIS FILE MUST NEVER
// STRING-MATCH A PAYLOAD to decide what an op is — that is the exact
// brittleness the ops log deletes. It reads `intent`, then pulls named fields
// out of the parsed payload.
//
// Layering: pure and colour-free. `src/cli/format.ts` adds picocolors
// for the terminal, and `src/cli/tui/` renders the same strings inside
// ink. Neither owns any prose logic — one formatter, three surfaces
// (ROADMAP: no second render layer).

import type { LocalIntent } from "./logs.js";

/** Every intent mu writes: the local ones (`emitEvent`, for changes no
 *  trigger can see) plus the capture-trigger ones (set via
 *  `withOpContext` around a portable-table mutation). */
export type CaptureIntent =
  | "task.add"
  | "task.update"
  | "task.note"
  | "task.delete"
  | "task.close"
  | "task.open"
  | "task.reject"
  | "task.defer"
  | "task.claim"
  | "task.release"
  | "task.reap"
  | "task.block"
  | "task.unblock"
  | "task.reparent"
  | "workstream.init"
  | "workstream.destroy";

export type KnownIntent = CaptureIntent | LocalIntent;

/** A log row, reduced to what rendering needs. Structural so both
 *  `LogRow` (the SDK shape) and raw op rows satisfy it. */
export interface RenderableOp {
  intent: string | null;
  /** `ops.entity`. */
  kind: string;
  /** `ops.key` — the natural key, verbatim. */
  workstreamName: string | null;
  payload: string;
  /** `ops.actor`. */
  source: string;
  op?: string;
}

/** Rendered op, split so callers can colour the verb independently.
 *  `subject` is the entity the line is about; `detail` is the
 *  human-readable consequence. */
export interface RenderedOp {
  /** Operator-facing verb, e.g. 'task close'. Colour this. */
  verb: string;
  /** The entity acted on, already stripped of workstream scope. */
  subject: string;
  /** What changed, in prose. May be empty. */
  detail: string;
}

// ─── payload access ────────────────────────────────────────────────────

/** Parse an op payload into a field bag. Tolerant by design: a payload
 *  that is not JSON (operator prose from `mu log write`) yields an empty
 *  bag rather than throwing, and the caller falls back to showing the
 *  text verbatim. */
function fields(payload: string): Record<string, unknown> {
  if (!payload.startsWith("{")) return {};
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(bag: Record<string, unknown>, key: string): string | undefined {
  const v = bag[key];
  return typeof v === "string" ? v : undefined;
}

function num(bag: Record<string, unknown>, key: string): number | undefined {
  const v = bag[key];
  return typeof v === "number" ? v : undefined;
}

/** Columns that are pure bookkeeping — never interesting on their own. */
const NOISE_FIELDS = new Set(["updated_at", "created_at"]);

/** Field names, in the order a human wants to read them. */
function changedFields(bag: Record<string, unknown>): string[] {
  return Object.keys(bag).filter((k) => !NOISE_FIELDS.has(k));
}

// ─── key parsing ───────────────────────────────────────────────────────

/**
 * Split a natural key into workstream + local part.
 *
 *   'demo'                 -> { workstream: 'demo' }
 *   'demo/t1'              -> { workstream: 'demo', local: 't1' }
 *   'demo/t1#3'            -> { workstream: 'demo', local: 't1', note: '3' }
 *   'demo/a->demo/b'       -> { workstream: 'demo', local: 'a', to: 'b' }
 */
export function parseOpKey(key: string | null): {
  workstream?: string;
  local?: string;
  note?: string;
  to?: string;
} {
  if (key === null || key === "") return {};
  // Edge keys are '<ws>/<from>-><ws>/<to>'.
  const arrow = key.indexOf("->");
  if (arrow !== -1) {
    const from = parseOpKey(key.slice(0, arrow));
    const to = parseOpKey(key.slice(arrow + 2));
    const out: { workstream?: string; local?: string; to?: string } = {};
    if (from.workstream !== undefined) out.workstream = from.workstream;
    if (from.local !== undefined) out.local = from.local;
    if (to.local !== undefined) out.to = to.local;
    return out;
  }
  const slash = key.indexOf("/");
  if (slash === -1) return { workstream: key };
  const workstream = key.slice(0, slash);
  const rest = key.slice(slash + 1);
  const hash = rest.indexOf("#");
  if (hash === -1) return { workstream, local: rest };
  return { workstream, local: rest.slice(0, hash), note: rest.slice(hash + 1) };
}

// ─── the formatter ─────────────────────────────────────────────────────

/** Human verb per intent. Space-separated so it reads as a command,
 *  matching how operators talk about these ('task close', not
 *  'task.close'). */
const VERBS: Record<KnownIntent, string> = {
  "task.add": "task add",
  "task.update": "task update",
  "task.note": "task note",
  "task.delete": "task delete",
  "task.close": "task close",
  "task.open": "task open",
  "task.reject": "task reject",
  "task.defer": "task defer",
  "task.claim": "task claim",
  "task.release": "task release",
  "task.reap": "task reap",
  "task.block": "task block",
  "task.unblock": "task unblock",
  "task.reparent": "task reparent",
  "workstream.init": "workstream init",
  "workstream.destroy": "workstream destroy",
  "agent.spawn": "agent spawn",
  "agent.close": "agent close",
  "agent.adopt": "agent adopt",
  "agent.kick": "agent kick",
  // Payload prose reads "agent stalled ..."; keep the verb matching it
  // so the emitted text is not printed with a second, different verb.
  "agent.stall": "agent stalled",
  "workspace.create": "workspace create",
  "workspace.free": "workspace free",
  "workspace.refresh": "workspace refresh",
};

/** Every intent this formatter knows, derived from the verb table so
 *  the two can't drift. */
export const KNOWN_INTENTS: readonly KnownIntent[] = Object.keys(VERBS) as KnownIntent[];

/** Every operator-facing verb the formatter can emit. Exported so audits
 *  can check "this emitter's verb is declared" without re-deriving it
 *  from the intent — the two are deliberately not always identical
 *  (`agent.stall` renders as "agent stalled", matching its payload). */
export const KNOWN_VERBS: readonly string[] = Object.values(VERBS);

function isKnownIntent(intent: string): intent is KnownIntent {
  return Object.hasOwn(VERBS, intent);
}

/**
 * Render one op as prose.
 *
 * Returns null when the row is not a rendered op at all — operator prose
 * from `mu log write` / a `--kind` ledger, which has no intent and
 * should be shown verbatim. Callers print `payload` in that case.
 */
export function renderOp(row: RenderableOp): RenderedOp | null {
  const intent = row.intent;
  if (intent === null) return null;

  // A bare status set (`setTaskStatus` with no more specific verb) uses
  // 'task.set-<status>' via intentIfUnset. Normalise it here rather than
  // enumerating six more table entries.
  const setPrefix = "task.set-";
  if (intent.startsWith(setPrefix)) {
    const status = intent.slice(setPrefix.length).toUpperCase();
    const { local } = parseOpKey(row.workstreamName);
    return { verb: "task status", subject: local ?? "", detail: `\u2192 ${status}` };
  }

  if (!isKnownIntent(intent)) {
    // Forward-compatible: an intent written by a NEWER mu (ingested from
    // a peer's segment) — or by the one-shot scripts/migrate.ts
    // importer, whose 'migrate.v8' / 'migrate.v8-log' ops deliberately
    // do NOT claim to be typed verbs — still renders legibly
    // instead of vanishing. Deliberately not a throw: sync must never
    // be blocked by a rendering gap.
    //
    // A PROSE payload is shown as the detail, because for an unknown
    // intent the prose is the only information the line carries and
    // dropping it renders a bare verb with no subject at all (which is
    // what every carried pre-1.0 log line looked like). A JSON payload is
    // still withheld — "no raw JSON in mu log" is a hard property —
    // and reduced to its changed field names.
    const bag = fields(row.payload);
    const detail = row.payload.startsWith("{")
      ? changedFields(bag).join(" ")
      : oneLine(row.payload, 100);
    return {
      verb: intent.replace(".", " "),
      subject: parseOpKey(row.workstreamName).local ?? "",
      detail,
    };
  }
  return renderKnown(row, intent);
}

/** Split from `renderOp` so the switch is this function's ONLY exit
 *  path: that is what makes TS treat it as exhaustive and reject a
 *  missing `KnownIntent` case at COMPILE time (TS2366), instead of
 *  silently falling through to a runtime default. */
function renderKnown(row: RenderableOp, intent: KnownIntent): RenderedOp {
  const bag = fields(row.payload);
  const key = parseOpKey(row.workstreamName);
  const subject = key.local ?? key.workstream ?? "";
  const deleted = row.op === "del";

  // Exhaustive switch over the closed union: adding an intent to VERBS
  // without handling it here is a COMPILE error, not a runtime fallback.
  switch (intent) {
    case "task.add": {
      const impact = num(bag, "impact");
      const effort = num(bag, "effort_days");
      const title = str(bag, "title");
      const bits: string[] = [];
      if (title !== undefined) bits.push(`"${title}"`);
      if (impact !== undefined) bits.push(`impact=${impact}`);
      if (effort !== undefined) bits.push(`effort=${effort}`);
      return { verb: VERBS[intent], subject, detail: bits.join(" ") };
    }
    case "task.update": {
      const changed = changedFields(bag);
      const detail = changed
        .map((f) => {
          const v = bag[f];
          return typeof v === "object" ? f : `${f}=${String(v)}`;
        })
        .join(" ");
      // A payload of only updated_at is a parent-row touch (a note or
      // edge bumped its task). Say so rather than printing nothing.
      return { verb: VERBS[intent], subject, detail: detail === "" ? "(touched)" : detail };
    }
    case "task.note": {
      const author = str(bag, "author");
      const content = str(bag, "content") ?? "";
      const n = key.note;
      const head = n === undefined ? "" : `#${n} `;
      const by = author === undefined || author === "" ? "" : ` by ${author}`;
      return { verb: VERBS[intent], subject, detail: `${head}${oneLine(content)}${by}` };
    }
    case "task.delete":
      // Always a tombstone (op='del'), so the payload is '{}' — there is
      // nothing to report beyond the fact of it.
      return { verb: VERBS[intent], subject, detail: "" };
    case "task.close":
    case "task.open":
    case "task.reject":
    case "task.defer": {
      const status = str(bag, "status");
      return { verb: VERBS[intent], subject, detail: status === undefined ? "" : `→ ${status}` };
    }
    case "task.claim": {
      // The payload cannot name the actor on the `--self` path (owner_id
      // stays NULL by design), so attribution comes from ops.actor.
      const by = row.source === "" ? "" : `by ${row.source}`;
      const status = str(bag, "status");
      const tail = status === undefined ? "" : ` → ${status}`;
      return { verb: VERBS[intent], subject, detail: `${by}${tail}` };
    }
    case "task.release":
    case "task.reap": {
      const status = str(bag, "status");
      const bits: string[] = [];
      if (Object.hasOwn(bag, "owner_id") && bag.owner_id === null) bits.push("owner cleared");
      if (status !== undefined) bits.push(`→ ${status}`);
      return { verb: VERBS[intent], subject, detail: bits.join(" ") };
    }
    case "task.block":
    case "task.unblock":
    case "task.reparent": {
      // Edge ops carry the pair in the key; the task-row op that shares
      // the group is just a touch.
      if (key.to !== undefined) {
        const dir = intent === "task.unblock" ? "no longer blocks" : "blocks";
        return { verb: VERBS[intent], subject, detail: `${dir} ${key.to}` };
      }
      return { verb: VERBS[intent], subject, detail: deleted ? "(edge removed)" : "(touched)" };
    }
    case "workstream.init":
      return { verb: VERBS[intent], subject, detail: "" };
    case "workstream.destroy":
      return {
        verb: VERBS[intent],
        subject,
        detail: key.local === undefined ? "" : "(cascaded)",
      };
    // Local intents: no trigger can see these, so `emitEvent` wrote the
    // payload as prose. It is already human-readable — show it as the
    // detail rather than inventing a second phrasing. The leading verb
    // is stripped so it is not printed twice.
    case "agent.spawn":
    case "agent.close":
    case "agent.adopt":
    case "agent.kick":
    case "agent.stall":
    case "workspace.create":
    case "workspace.free":
    case "workspace.refresh": {
      const verb = VERBS[intent];
      // These payloads are prose by construction (emitEvent writes them).
      // Guard anyway: a JSON payload here would otherwise be dumped raw
      // into the line, and "no raw JSON in mu log" is a hard property.
      if (row.payload.startsWith("{")) {
        const named = str(bag, "name") ?? subject;
        return { verb, subject: named, detail: changedFields(bag).join(" ") };
      }
      const prose = row.payload.startsWith(verb)
        ? row.payload.slice(verb.length).trim()
        : row.payload;
      const firstSpace = prose.indexOf(" ");
      const name = firstSpace === -1 ? prose : prose.slice(0, firstSpace);
      const rest = firstSpace === -1 ? "" : prose.slice(firstSpace + 1).trim();
      return { verb, subject: name, detail: rest };
    }
  }
}

/** Collapse a multi-line string to one line, truncated. Note contents
 *  are free text and can be paragraphs; a log line is a line. */
function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Render an op as a single plain-text string. The convenience form for
 * callers that don't colour the verb separately (JSON `rendered` field,
 * TUI cards with their own column layout).
 */
export function renderOpLine(row: RenderableOp): string {
  const r = renderOp(row);
  if (r === null) return oneLine(row.payload, 120);
  return [r.verb, r.subject, r.detail].filter((s) => s !== "").join(" ");
}

/**
 * The entity a row is about, for building a "show me this" command.
 * Reads `intent` + `key`, never prose.
 */
export function opSubject(row: RenderableOp): { kind: "task" | "agent"; id: string } | null {
  const intent = row.intent;
  if (intent === null) return null;
  const { local } = parseOpKey(row.workstreamName);
  if (intent.startsWith("task.") && local !== undefined && local !== "") {
    return { kind: "task", id: local };
  }
  if (intent.startsWith("agent.") || intent.startsWith("workspace.")) {
    const r = renderOp(row);
    if (r !== null && r.subject !== "") return { kind: "agent", id: r.subject };
  }
  return null;
}
