// Tests for the unified `mu state` verb.
//
// `mu state` owns the static state card, the bare-`mu` glance card,
// and the opt-in TUI:
//
//   mu state             default: full top-to-bottom card
//   mu state --tui       interactive ink dashboard (read-only)
//   mu state --mission   stripped 5-col glance card (bare-`mu` alias)
//
// `--tui` is mutually exclusive with `--json` and `--mission`. All
// modes accept variadic `-w X[,Y]...` / `-w X -w Y` and `--all`.
//
// Tests exercise: full render, mission render, mutual-exclusion error,
// cross-workstream handling, and JSON shapes per spec. TUI specifics
// live in the `test/tui-*.test.ts` files.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalNoColor = vi.hoisted(() => process.env.NO_COLOR);

// Force colorless output for the whole file (literal-substring
// assertions vs ANSI escapes). The `pc` instance is baked at
// src/output.ts module-load time; vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});

afterAll(() => {
  if (originalNoColor === undefined) {
    const key = "NO_COLOR";
    delete process.env[key];
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});
import { runCli } from "./_runCli.js";

// ── default mode (full top-to-bottom card) ─────────────────────────

describe("mu state — default (full) mode", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-full-"));
    dbPath = join(tempDir, "mu.db");
    await runCli(["workstream", "init", "ws", "--json"], dbPath);
    await runCli(
      ["task", "add", "alpha", "-w", "ws", "--title", "A", "-i", "50", "-e", "1", "--json"],
      dbPath,
    );
    await runCli(
      ["task", "add", "beta", "-w", "ws", "--title", "B", "-i", "60", "-e", "1", "--json"],
      dbPath,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("renders every full-mode section heading top-to-bottom", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-ws");
    expect(stdout).toContain("Agents (");
    expect(stdout).toContain("Tracks (");
    expect(stdout).toContain("Ready (");
    expect(stdout).toContain("In progress (");
    expect(stdout).toContain("Blocked (");
    expect(stdout).toContain("Recent closed (");
    expect(stdout).toContain("Workspaces (");
    expect(stdout).toContain("Recent events");
  });

  it("--json emits the unified flat shape (single workstream)", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    // Spec: { workstreamName, agents, orphans, tracks, ready, blocked,
    //         inProgress, recentClosed, workspaces, recent } (flat).
    expect(parsed.workstreamName).toBe("ws");
    expect(parsed.agents).toEqual([]);
    expect(parsed.orphans).toEqual([]);
    expect(parsed.tracks).toEqual([
      expect.objectContaining({
        roots: [expect.objectContaining({ name: "alpha", title: "A" })],
        readyCount: 1,
      }),
      expect.objectContaining({
        roots: [expect.objectContaining({ name: "beta", title: "B" })],
        readyCount: 1,
      }),
    ]);
    expect(parsed.ready).toEqual([
      expect.objectContaining({ name: "beta", title: "B", status: "OPEN", roi: 60 }),
      expect.objectContaining({ name: "alpha", title: "A", status: "OPEN", roi: 50 }),
    ]);
    expect(parsed.blocked).toEqual([]);
    expect(parsed.inProgress).toEqual([]);
    expect(parsed.recentClosed).toEqual([]);
    expect(parsed.workspaces).toEqual([]);
    expect(parsed.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          payload: expect.stringContaining("task add alpha"),
        }),
        expect.objectContaining({
          kind: "event",
          payload: expect.stringContaining("task add beta"),
        }),
      ]),
    );
  });

  it("multi-ws --json wraps per-ws shapes in { workstreams: [...] }", async () => {
    await runCli(["workstream", "init", "ws2", "--json"], dbPath);
    await runCli(
      ["task", "add", "gamma", "-w", "ws2", "--title", "G", "-i", "10", "-e", "1", "--json"],
      dbPath,
    );
    const { stdout, exitCode } = await runCli(["state", "-w", "ws,ws2", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.workstreams).toEqual([
      expect.objectContaining({
        workstreamName: "ws",
        ready: expect.arrayContaining([
          expect.objectContaining({ name: "alpha", title: "A", status: "OPEN" }),
          expect.objectContaining({ name: "beta", title: "B", status: "OPEN" }),
        ]),
        blocked: [],
        workspaces: [],
      }),
      expect.objectContaining({
        workstreamName: "ws2",
        ready: [expect.objectContaining({ name: "gamma", title: "G", status: "OPEN" })],
        blocked: [],
        workspaces: [],
      }),
    ]);
  });
});

// ── --mission (stripped 5-col glance) ──────────────────────────────

describe("mu state --mission — stripped glance card", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-mission-"));
    dbPath = join(tempDir, "mu.db");
    await runCli(["workstream", "init", "ws", "--json"], dbPath);
    await runCli(
      ["task", "add", "alpha", "-w", "ws", "--title", "A", "-i", "50", "-e", "1", "--json"],
      dbPath,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("renders only the 5-col glance sections (agents + orphans + tracks + ready)", async () => {
    const { stdout, exitCode } = await runCli(["state", "--mission", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("mu-ws");
    expect(stdout).toContain("Agents (");
    expect(stdout).toContain("Tracks (");
    expect(stdout).toContain("Ready (");
    // Stripped: NOT in mission render.
    expect(stdout).not.toContain("In progress (");
    expect(stdout).not.toContain("Blocked (");
    expect(stdout).not.toContain("Recent closed (");
    expect(stdout).not.toContain("Workspaces (");
    expect(stdout).not.toContain("Recent events");
  });

  it("--mission --json emits the stripped subset shape ONLY", async () => {
    const { stdout, exitCode } = await runCli(["state", "--mission", "-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    // Spec: { workstreamName, agents, orphans, tracks, ready }. No
    // blocked / inProgress / recentClosed / workspaces / recent.
    expect(Object.keys(parsed).sort()).toEqual(
      ["agents", "orphans", "ready", "tracks", "workstreamName"].sort(),
    );
    expect(parsed.workstreamName).toBe("ws");
    expect(parsed.ready).toEqual([
      expect.objectContaining({ name: "alpha", title: "A", status: "OPEN", roi: 50 }),
    ]);
  });

  it("bare `mu` (no verb) is an alias for `mu state --mission`", async () => {
    // Bare-mu invokes cmdState({ mission: true }) — output should
    // match the explicit --mission invocation (modulo any timing noise
    // in the recent-events table; mission strips that section so the
    // human render is deterministic).
    const bare = await runCli(["-w", "ws"], dbPath);
    const explicit = await runCli(["state", "--mission", "-w", "ws"], dbPath);
    expect(bare.exitCode).toBeNull();
    expect(explicit.exitCode).toBeNull();
    // Both contain the same stripped section headings; neither
    // contains the full-mode sections.
    for (const out of [bare.stdout, explicit.stdout]) {
      expect(out).toContain("mu-ws");
      expect(out).toContain("Agents (");
      expect(out).toContain("Tracks (");
      expect(out).toContain("Ready (");
      expect(out).not.toContain("Workspaces (");
      expect(out).not.toContain("Recent events");
    }
  });

  it("bare `mu --json` emits the stripped --mission shape", async () => {
    const { stdout, exitCode } = await runCli(["-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual(
      ["agents", "orphans", "ready", "tracks", "workstreamName"].sort(),
    );
    expect(parsed.ready).toEqual([
      expect.objectContaining({ name: "alpha", title: "A", status: "OPEN", roi: 50 }),
    ]);
  });
});

// ── mutual exclusion + cross-workstream ────────────────────────────

describe("mu state — mutual-exclusion + cross-workstream", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-mux-"));
    dbPath = join(tempDir, "mu.db");
    for (const w of ["alpha", "beta", "gamma"]) {
      await runCli(["workstream", "init", w, "--json"], dbPath);
      await runCli(
        ["task", "add", `t_${w}`, "-w", w, "--title", `T-${w}`, "-i", "50", "-e", "1", "--json"],
        dbPath,
      );
    }
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("--all + -w errors as a UsageError (mutually exclusive)", async () => {
    const { stderr, exitCode } = await runCli(["state", "--all", "-w", "alpha"], dbPath);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("mutually exclusive");
  });

  it("cross-workstream works in default mode (-w X,Y stacks per-ws cards)", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "alpha,beta"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-alpha");
    expect(stdout).toContain("State of mu-beta");
    expect(stdout).not.toContain("State of mu-gamma");
  });

  it("cross-workstream works in --mission mode (-w X,Y stacks per-ws cards)", async () => {
    const { stdout, exitCode } = await runCli(["state", "--mission", "-w", "alpha,beta"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("mu-alpha");
    expect(stdout).toContain("mu-beta");
    expect(stdout).not.toContain("mu-gamma");
  });

  it("-w with one bad name errors as WorkstreamNotFoundError", async () => {
    const { stderr, exitCode } = await runCli(["state", "-w", "alpha,nope"], dbPath);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("nope");
  });
});

// ── classifyEventVerb regression: every emitter verb is recognised ──
//
// Per the TUI refactor (Wave 2 Task 10): the parsing half of the previous
// event colourer lives at src/logs.ts as `classifyEventVerb` (verb
// extraction only; renderers apply their own colour). This block
// preserves the old guarantees verbatim, just without the cyan part:
// (a) every entry in EVENT_VERB_PREFIXES round-trips, (b) every
// emitEvent callsite under src/ uses a payload prefix that is
// recognised. Plus the false-positive guard.
describe("classifyEventVerb", () => {
  it("recognises every verb in EVENT_VERB_PREFIXES", async () => {
    const { EVENT_VERB_PREFIXES, classifyEventVerb } = await import("../src/logs.js");
    expect(EVENT_VERB_PREFIXES.length).toBeGreaterThan(0);
    for (const verb of EVENT_VERB_PREFIXES) {
      const payload = `${verb} alpha (extra info)`;
      const r = classifyEventVerb(payload);
      expect(r, `verb '${verb}' should classify`).not.toBeNull();
      expect(r?.verb).toBe(verb);
      expect(r?.rest).toBe(" alpha (extra info)");
    }
  });

  it("returns null for unknown payloads (no false-positive matches)", async () => {
    const { classifyEventVerb } = await import("../src/logs.js");
    for (const payload of [
      "random freeform message",
      "approve granted slug",
      "snapshot capture foo",
      "taskaddendum sneaky",
    ]) {
      expect(classifyEventVerb(payload)).toBeNull();
    }
  });

  // AST-based audit of every emitEvent callsite under src/. The
  // earlier regex-grep version (review_eventprefix_grep_test_brittle)
  // had three loopholes that silently let drift through:
  //   1. Variable third args (`emitEvent(db, ws, msg)`) never matched.
  //   2. Template literals starting with interpolation (`\`${kind}
  //      foo\``) collapsed to empty head and were skipped.
  //   3. The `words.length === 2` filter dropped any single-word
  //      payload outright.
  // Walking the AST removes the regex altogether: every CallExpression
  // named `emitEvent` is examined, the payload-shape is resolved by
  // syntax (string literal / no-substitution template / template
  // expression / `formatClaimEvent({prose: ...})`), and any payload we
  // can't extract is itself a failure. That makes the test airtight
  // — the property it claims to enforce.
  it("every emitEvent callsite under src/ uses a payload prefix in EVENT_VERB_PREFIXES", async () => {
    const { EVENT_VERB_PREFIXES } = await import("../src/logs.js");
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join: pj } = await import("node:path");
    const ts = await import("typescript");

    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = pj(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
      }
      return out;
    }

    /**
     * Resolve a payload AST node to a literal string in which every
     * `${...}` interpolation is replaced by the sentinel `\x00`. The
     * sentinel marks 'unknown text here' without colliding with any
     * real character a verb prefix could legitimately use.
     *
     * Returns null when the node is a form we can't statically
     * resolve (a bare identifier, a function call other than
     * `formatClaimEvent`, a binary `+` chain, etc.). The caller
     * treats null as a hard failure: every emitEvent payload MUST be
     * one of the recognised shapes.
     */
    function resolvePayload(node: import("typescript").Node): string | null {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
      }
      if (ts.isTemplateExpression(node)) {
        let out = node.head.text;
        for (const span of node.templateSpans) {
          out += `\x00${span.literal.text}`;
        }
        return out;
      }
      // formatClaimEvent({ prose: "task claim ...", ... })
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "formatClaimEvent" &&
        node.arguments.length === 1
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "prose"
            ) {
              return resolvePayload(prop.initializer);
            }
          }
        }
      }
      return null;
    }

    interface Site {
      file: string;
      line: number;
      payload: string | null;
    }
    const sites: Site[] = [];
    for (const file of walk("src")) {
      const src = readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      const visit = (node: import("typescript").Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "emitEvent" &&
          node.arguments.length >= 3
        ) {
          const payloadArg = node.arguments[2];
          const payload = payloadArg ? resolvePayload(payloadArg) : null;
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          sites.push({ file, line: line + 1, payload });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // Sanity: we should have found every callsite. The codebase has
    // ~20+ live emitters; if this drops to a handful the AST walk has
    // regressed (e.g. wrong identifier name).
    expect(sites.length).toBeGreaterThanOrEqual(20);

    // No callsite may have an unresolvable payload. If you hit this,
    // either (a) refactor the emitter to use one of the recognised
    // shapes (literal / template / formatClaimEvent({prose: ...})),
    // or (b) extend `resolvePayload` above to handle the new shape.
    const unresolved = sites.filter((s) => s.payload === null);
    expect(
      unresolved,
      `emitEvent callsites whose payload shape we can't statically resolve (extend resolvePayload): ${JSON.stringify(
        unresolved.map((s) => `${s.file}:${s.line}`),
        null,
        2,
      )}`,
    ).toEqual([]);

    // Build the prefix-match check. A payload matches if it begins
    // with `<verb> ` for some verb in EVENT_VERB_PREFIXES, OR equals
    // the verb exactly (single-token tail), OR begins with `<verb>\x00`
    // (a template literal where the next token is interpolated).
    const knownPrefixes = [...EVENT_VERB_PREFIXES];
    const matches = (payload: string): string | null => {
      for (const verb of knownPrefixes) {
        if (
          payload === verb ||
          payload.startsWith(`${verb} `) ||
          payload.startsWith(`${verb}\x00`) ||
          payload.startsWith(`${verb}.`)
        ) {
          return verb;
        }
      }
      return null;
    };
    const unknown = sites
      .filter((s) => s.payload !== null && matches(s.payload) === null)
      .map((s) => ({ file: s.file, line: s.line, payload: s.payload }));
    expect(
      unknown,
      `emitEvent callsites whose payload prefix is not in EVENT_VERB_PREFIXES: ${JSON.stringify(unknown, null, 2)}`,
    ).toEqual([]);
  });
});
