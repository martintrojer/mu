// v2-log-verb — the ONE op → prose formatter (src/log-render.ts).
//
// v1 rendered log lines by prefix-matching free prose against
// EVENT_VERB_PREFIXES, and CLAIM_EVENT_PREFIX was bolted on because that
// matching kept breaking. The load-bearing property now is the opposite:
// rendering reads `intent` + `key` + named payload fields, and NEVER
// string-matches a payload to decide what an op is. These tests pin that.
//
// Exhaustiveness is enforced at COMPILE time (renderKnown's switch is its
// only exit path, so a missing KnownIntent is TS2366 — it caught a missing
// `task.delete` case while this was being written). The runtime test below
// is the belt to that suspenders: it walks KNOWN_INTENTS and asserts each
// produces real prose.

import { describe, expect, it } from "vitest";
import {
  KNOWN_INTENTS,
  type RenderableOp,
  opSubject,
  parseOpKey,
  renderOp,
  renderOpLine,
} from "../src/log-render.js";

/** Minimal op row. Defaults are a task op so cases stay terse. */
function op(over: Partial<RenderableOp> = {}): RenderableOp {
  return {
    intent: "task.add",
    kind: "task",
    workstreamName: "demo/t1",
    payload: "{}",
    source: "system",
    op: "put",
    ...over,
  };
}

describe("parseOpKey", () => {
  it("splits the natural key into its parts", () => {
    expect(parseOpKey("demo")).toEqual({ workstream: "demo" });
    expect(parseOpKey("demo/t1")).toEqual({ workstream: "demo", local: "t1" });
    expect(parseOpKey("demo/t1#3")).toEqual({ workstream: "demo", local: "t1", note: "3" });
    expect(parseOpKey("demo/a->demo/b")).toEqual({ workstream: "demo", local: "a", to: "b" });
  });

  it("is total on empty / null keys", () => {
    expect(parseOpKey(null)).toEqual({});
    expect(parseOpKey("")).toEqual({});
  });

  it("keeps ids containing dashes intact (edge split is on '->')", () => {
    expect(parseOpKey("demo/my-task")).toEqual({ workstream: "demo", local: "my-task" });
  });
});

describe("renderOp covers every known intent", () => {
  // The runtime half of exhaustiveness. A new intent added to the verb
  // table but left unhandled would fail to compile; this catches an
  // intent that compiles but renders as nothing useful.
  it("every KNOWN_INTENT yields a non-empty verb and no raw JSON", () => {
    for (const intent of KNOWN_INTENTS) {
      const r = renderOp(op({ intent, payload: '{"status":"OPEN","impact":5}' }));
      expect(r, `${intent} must render`).not.toBeNull();
      if (r === null) continue;
      expect(r.verb.length, `${intent} needs a verb`).toBeGreaterThan(0);
      // The verb reads as a command, not as a dotted identifier.
      expect(r.verb).not.toContain(".");
      expect(`${r.verb} ${r.subject} ${r.detail}`).not.toContain("{");
    }
  });

  it("KNOWN_INTENTS covers both capture and local intents", () => {
    expect(KNOWN_INTENTS).toContain("task.close");
    expect(KNOWN_INTENTS).toContain("workstream.destroy");
    expect(KNOWN_INTENTS).toContain("agent.spawn");
    expect(KNOWN_INTENTS).toContain("workspace.refresh");
  });
});

describe("renderOp prose", () => {
  it("task.add names the title, impact and effort", () => {
    const r = renderOp(
      op({
        intent: "task.add",
        payload: '{"local_id":"t1","title":"Build auth","impact":80,"effort_days":3}',
      }),
    );
    expect(r?.verb).toBe("task add");
    expect(r?.subject).toBe("t1");
    expect(r?.detail).toBe('"Build auth" impact=80 effort=3');
  });

  it("task.update names only the fields that changed, ignoring bookkeeping", () => {
    const r = renderOp(
      op({ intent: "task.update", payload: '{"impact":90,"updated_at":"2026-01-01T00:00:00Z"}' }),
    );
    expect(r?.detail).toBe("impact=90");
  });

  it("task.close reads as a status transition", () => {
    const r = renderOp(op({ intent: "task.close", payload: '{"status":"CLOSED"}' }));
    expect(renderOpLine(op({ intent: "task.close", payload: '{"status":"CLOSED"}' }))).toBe(
      "task close t1 → CLOSED",
    );
    expect(r?.detail).toBe("→ CLOSED");
  });

  it("task.claim attributes via ops.actor, since the payload cannot on --self", () => {
    // The --self path leaves owner_id NULL by design, so the payload has
    // no owner to name; ops.actor is the only record.
    const r = renderOp(
      op({ intent: "task.claim", source: "deploy-bot", payload: '{"status":"IN_PROGRESS"}' }),
    );
    expect(r?.detail).toContain("by deploy-bot");
    expect(r?.detail).toContain("→ IN_PROGRESS");
  });

  it("task.note shows the note number, a one-line excerpt, and the author", () => {
    const r = renderOp(
      op({
        intent: "task.note",
        workstreamName: "demo/t1#2",
        payload: '{"author":"worker-1","content":"line one\\nline two"}',
      }),
    );
    expect(r?.detail).toBe("#2 line one line two by worker-1");
  });

  it("collapses and truncates long note bodies to one line", () => {
    const long = "x".repeat(200);
    const r = renderOp(
      op({ intent: "task.note", payload: JSON.stringify({ author: "a", content: long }) }),
    );
    expect(r?.detail).toContain("…");
    expect(r?.detail).not.toContain("\n");
    expect((r?.detail ?? "").length).toBeLessThan(90);
  });

  it("edge intents read directionally from the key pair", () => {
    const blocked = renderOp(op({ intent: "task.block", workstreamName: "demo/a->demo/b" }));
    expect(blocked?.detail).toBe("blocks b");
    const un = renderOp(op({ intent: "task.unblock", workstreamName: "demo/a->demo/b" }));
    expect(un?.detail).toBe("no longer blocks b");
  });

  it("a bare status set (task.set-*) renders without needing its own verb entry", () => {
    const r = renderOp(op({ intent: "task.set-in_progress" }));
    expect(r?.verb).toBe("task status");
    expect(r?.detail).toBe("→ IN_PROGRESS");
  });

  it("local intents reuse their prose payload without repeating the verb", () => {
    const r = renderOp(
      op({
        intent: "agent.spawn",
        kind: "agent",
        workstreamName: "demo",
        payload: "agent spawn worker-1 (cli=pi, role=full-access, pane=%3)",
      }),
    );
    expect(r?.verb).toBe("agent spawn");
    expect(r?.subject).toBe("worker-1");
    // The verb must not appear twice in the rendered line.
    expect(
      renderOpLine(
        op({
          intent: "agent.spawn",
          kind: "agent",
          workstreamName: "demo",
          payload: "agent spawn worker-1 (cli=pi)",
        }),
      ).match(/agent spawn/g),
    ).toHaveLength(1);
  });

  it("a tombstone edge says so rather than claiming a touch", () => {
    const r = renderOp(op({ intent: "task.unblock", op: "del", workstreamName: "demo/t1" }));
    expect(r?.detail).toBe("(edge removed)");
  });
});

describe("renderOp is never fooled by payload text", () => {
  // The anti-regression for v1's whole failure mode. A payload that LOOKS
  // like another verb must not be classified as one — the intent decides.
  it("payload prose cannot override the intent", () => {
    const r = renderOp(
      op({ intent: "task.close", payload: '{"status":"CLOSED","title":"task delete everything"}' }),
    );
    expect(r?.verb).toBe("task close");
  });

  it("an intentless row renders null so callers show it verbatim", () => {
    // `mu log write` / a --kind ledger. Inventing a verb would be wrong.
    expect(renderOp(op({ intent: null, payload: "pr=1234 ci=red" }))).toBeNull();
    expect(renderOpLine(op({ intent: null, payload: "pr=1234 ci=red" }))).toBe("pr=1234 ci=red");
  });

  it("a non-JSON payload on a real intent degrades instead of throwing", () => {
    const r = renderOp(op({ intent: "task.update", payload: "not json at all" }));
    expect(r).not.toBeNull();
    expect(r?.verb).toBe("task update");
  });

  it("an UNKNOWN intent from a newer mu still renders legibly", () => {
    // Ingested from a peer's segment. Must not vanish and must not throw:
    // a rendering gap may never block sync.
    const r = renderOp(op({ intent: "task.futureverb", workstreamName: "demo/t9" }));
    expect(r?.verb).toBe("task futureverb");
    expect(r?.subject).toBe("t9");
  });
});

describe("opSubject resolves the show-command target from structure", () => {
  it("task ops resolve to the task id from the key", () => {
    expect(opSubject(op({ intent: "task.close", workstreamName: "demo/t1" }))).toEqual({
      kind: "task",
      id: "t1",
    });
    // Note keys carry a #n suffix that must not leak into the id.
    expect(opSubject(op({ intent: "task.note", workstreamName: "demo/t1#4" }))).toEqual({
      kind: "task",
      id: "t1",
    });
  });

  it("agent ops resolve to the agent name", () => {
    expect(
      opSubject(
        op({
          intent: "agent.spawn",
          kind: "agent",
          workstreamName: "demo",
          payload: "agent spawn worker-7 (cli=pi)",
        }),
      ),
    ).toEqual({ kind: "agent", id: "worker-7" });
  });

  it("keeps dashed task ids intact (v1's logRowSubject truncated them)", () => {
    // The retired logRowSubject split on /[#>-]/, so a task named
    // 'my-task' yanked `mu task show my`. Splitting on the KEY structure
    // instead of a character class fixes it.
    expect(opSubject(op({ intent: "task.close", workstreamName: "demo/my-task" }))).toEqual({
      kind: "task",
      id: "my-task",
    });
  });

  it("intentless prose has no subject", () => {
    expect(opSubject(op({ intent: null, payload: "just a note" }))).toBeNull();
  });
});
