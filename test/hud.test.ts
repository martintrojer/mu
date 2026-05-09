// Tests for the `mu hud` verb.
//
// The HUD has two surfaces:
// 1. Human render (default) — dynamic table layout that fills the
//    terminal (or tmux pane) height + width with as much useful data
//    as fits. Driven by `MU_HUD_FORCE_SIZE=WxH` in tests so we can
//    exercise tiny / medium / huge panes deterministically.
// 2. `--json` — structured machine-readable shape (unchanged across
//    the dynamic-layout rewrite; many scripts depend on it).
//
// Tests use runCli + a real SQLite DB, no tmux side effects.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force colorless output for the whole file. The literal-substring
// assertions below (e.g. `expect(stdout).toContain("ready  alpha")`)
// fail when picocolors emits ANSI escapes around HUD cells. The HUD's
// `pc` instance is baked at src/output.ts module-load time, so we have
// to set NO_COLOR *before* `./_runCli.js` is imported (which transitively
// imports src/output.ts). vi.hoisted() moves this above the imports.
// `colorEnabled()` honors NO_COLOR over every other signal
// (TMUX/FORCE_COLOR/MU_FORCE_COLOR), so this disables ANSI regardless
// of how the test runner was launched (e.g. `npm test` inside tmux).
vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});
import { runCli } from "./_runCli.js";

describe("mu hud", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-hud-test-"));
    dbPath = join(tempDir, "mu.db");
    // Seed: workstream + 2 ready tasks (independent → 2 tracks).
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
    } catch {
      // best effort
    }
    const key = "MU_HUD_FORCE_SIZE";
    delete process.env[key];
  });

  // ── Human render: default at a roomy size ──────────────────────────

  it("default mode renders an all-tables layout: every section is a header-less cli-table3 with hint words baked into cells", async () => {
    process.env.MU_HUD_FORCE_SIZE = "120x40";
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();

    // Box-drawing chars present everywhere (every section is a table).
    expect(stdout).toContain("┌");
    expect(stdout).toContain("│");

    // Workstream-summary table: each cell carries its dim section word.
    expect(stdout).toContain("mu-ws");
    expect(stdout).toMatch(/2 ready/);
    expect(stdout).toMatch(/0 in-progress/);
    expect(stdout).toMatch(/2 tracks/);

    // No agent rows seeded → no agents table (skip empty sections).
    // Ready tasks present — 'ready  <id>' baked in as the first cell.
    expect(stdout).toContain("ready  alpha");
    expect(stdout).toContain("ready  beta");
    expect(stdout).toContain("ROI "); // 'ROI 50' / 'ROI 60' baked into the ROI cell

    // No in-progress tasks → section skipped (no rows with the
    // baked-in 'in-progress  <id>' double-space prefix).
    expect(stdout).not.toMatch(/in-progress {2}/);

    // Tracks table: hints baked into each cell ('track 1', 'N tasks',
    // 'N ready', 'merged' / 'track').
    expect(stdout).toContain("track 1");
    expect(stdout).toMatch(/\d+ tasks/);
    expect(stdout).toMatch(/\d+ ready/);

    // Recent-events table: '+ago' format + 'task add ...' payload
    // self-identify the rows (no header).
    expect(stdout).toMatch(/\+\d+s/);
    expect(stdout).toContain("task add");
  });

  // ── Tiny pane — only the highest-priority sections fit ─────────────

  it("medium pane (60x14) drops lower-priority sections + shows '+N more' truncation", async () => {
    // Add many ready tasks so the ready table can't fit them all.
    for (const id of ["gamma", "delta", "eps", "zeta", "eta", "theta"]) {
      await runCli(
        ["task", "add", id, "-w", "ws", "--title", id, "-i", "50", "-e", "1", "--json"],
        dbPath,
      );
    }
    // 60x14 budget: header table = 5 lines; 9 left.
    // Truncated ready = pick N s.t. 2N+3 <= 9-1 (footer reserve);
    // ⇒ N=2; ready prints 5+1 = 6 lines; remaining = 3 → nothing else fits.
    process.env.MU_HUD_FORCE_SIZE = "60x14";
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();

    // Summary table still fits (cells carry their own dim section words).
    expect(stdout).toContain("mu-ws");
    expect(stdout).toContain("ready");

    // Ready section fits but truncated; '+N more' footer fires.
    expect(stdout).toContain("ready  alpha");
    expect(stdout).toMatch(/… \+\d+ more \(mu task ready -w ws\)/);

    // Less important sections (in-progress empty, tracks/recent come
    // later) can't fit — no recent-events rows in output.
    expect(stdout).not.toContain("task add");
  });

  // ── Width-aware truncation ────────────────────────────────────────

  it("narrow width truncates long titles with ellipsis", async () => {
    await runCli(
      [
        "task",
        "add",
        "longtitle",
        "-w",
        "ws",
        "--title",
        "This is a very long task title that definitely overflows a narrow column",
        "-i",
        "50",
        "-e",
        "1",
        "--json",
      ],
      dbPath,
    );
    process.env.MU_HUD_FORCE_SIZE = "60x40";
    const { stdout } = await runCli(["hud", "-w", "ws"], dbPath);
    // Title was truncated → ellipsis present.
    expect(stdout).toContain("…");
    // The full title did NOT make it through verbatim.
    expect(stdout).not.toContain(
      "This is a very long task title that definitely overflows a narrow column",
    );
  });

  // ── Empty workstream renders cleanly ──────────────────────────────

  it("empty workstream renders just the workstream-summary table (every other section skipped)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mu-hud-empty-"));
    const emptyDb = join(empty, "mu.db");
    try {
      await runCli(["workstream", "init", "empty", "--json"], emptyDb);
      process.env.MU_HUD_FORCE_SIZE = "100x30";
      const { stdout, exitCode } = await runCli(["hud", "-w", "empty"], emptyDb);
      expect(exitCode).toBeNull();
      expect(stdout).toContain("mu-empty");

      // Sections with no rows → skipped entirely (every section is
      // header-less, so the only signal is the data row itself).
      expect(stdout).not.toMatch(/ready {2}/); // no ready task rows
      expect(stdout).not.toMatch(/in-progress {2}/); // no in-progress task rows
      expect(stdout).not.toContain("track 1"); // tracks table absent
      // `workstream init` emits a kind=event row, so the recent
      // table does render that single entry (with no header, just data).
      expect(stdout).toContain("workstream init empty");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // ── Sizing math regression ──────────────────────────────

  it("output never exceeds the forced height (no overflow)", async () => {
    // Add many ready tasks to make the ready table want more rows than
    // fit. Forced size 60x12: header table (5) + ready section (some).
    for (const id of ["gamma", "delta", "eps", "zeta", "eta", "theta", "iota", "kappa"]) {
      await runCli(
        ["task", "add", id, "-w", "ws", "--title", id, "-i", "50", "-e", "1", "--json"],
        dbPath,
      );
    }
    for (const height of [10, 12, 14, 20]) {
      process.env.MU_HUD_FORCE_SIZE = `60x${height}`;
      const { stdout } = await runCli(["hud", "-w", "ws"], dbPath);
      const lineCount = stdout.split("\n").filter((l) => l.length > 0).length;
      expect(lineCount).toBeLessThanOrEqual(height);
    }
  });

  // ── MU_HUD_FORCE_SIZE input validation ────────────────────────────

  it("MU_HUD_FORCE_SIZE rejects malformed values with a UsageError", async () => {
    process.env.MU_HUD_FORCE_SIZE = "not-a-size";
    const { stderr, exitCode } = await runCli(["hud", "-w", "ws"], dbPath);
    expect(exitCode).toBe(2); // UsageError -> exit 2
    expect(stderr).toContain("MU_HUD_FORCE_SIZE");
  });

  // ── --json shape ──────────────────────────────────────────────────

  it("--json mode emits structured shape with all keys (unchanged across the rewrite)", async () => {
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.workstream).toBe("ws");
    expect(parsed.summary).toEqual({
      ready: 2,
      inProgress: 0,
      tracks: 2,
      agents: 0,
      orphans: 0,
    });
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(Array.isArray(parsed.orphans)).toBe(true);
    expect(Array.isArray(parsed.tracks)).toBe(true);
    expect(parsed.tracks.length).toBe(2);
    expect(Array.isArray(parsed.ready)).toBe(true);
    expect(parsed.ready.length).toBe(2);
    expect(Array.isArray(parsed.inProgress)).toBe(true);
    expect(Array.isArray(parsed.recent)).toBe(true);
  });

  it("-n caps recent-events tail at exactly N entries (asserted via --json)", async () => {
    // Each task add emits a kind=event row; produce several.
    for (const id of ["gamma", "delta", "epsilon", "zeta"]) {
      await runCli(
        ["task", "add", id, "-w", "ws", "--title", id, "-i", "50", "-e", "1", "--json"],
        dbPath,
      );
    }
    const oneJson = JSON.parse(
      (await runCli(["hud", "-w", "ws", "--json", "-n", "1"], dbPath)).stdout,
    );
    expect(oneJson.recent.length).toBe(1);
    const threeJson = JSON.parse(
      (await runCli(["hud", "-w", "ws", "--json", "-n", "3"], dbPath)).stdout,
    );
    expect(threeJson.recent.length).toBe(3);
  });
});

// ── colorEventPayload regression: every emitter verb is recognised ──
//
// The HUD's recent-events tail colours the leading verb token of each
// event-log payload so the eye can group events at a glance. Before
// review_code_hud_event_color_regex_drift the colourer used a hand-
// maintained regex that drifted: `task block`, `task reparent`, and
// `approval granted` were emitted by the SDK but missed by the regex,
// rendering as plain dim text. The fix moved the verb list to a
// single source of truth (EVENT_VERB_PREFIXES in src/logs.ts) and the
// HUD reads from it.
//
// This block enforces the contract two ways:
//   1. Every entry in EVENT_VERB_PREFIXES round-trips through
//      colorEventPayload as a recognised, coloured verb.
//   2. Every `emitEvent(...)` call under src/ produces a payload
//      whose first two tokens match an entry in EVENT_VERB_PREFIXES.
//      So a contributor adding a new emitter without updating the
//      list breaks this test, not the user's HUD silently.
//
// We need real ANSI colour for assertion (1), but the rest of this
// file forces NO_COLOR. Re-enable colour, reset module cache, then
// dynamic-import the freshly-built `pc` instance and the colourer.
describe("colorEventPayload", () => {
  let savedNoColor: string | undefined;
  let savedForceColor: string | undefined;
  beforeEach(() => {
    savedNoColor = process.env.NO_COLOR;
    savedForceColor = process.env.MU_FORCE_COLOR;
    const noColorKey = "NO_COLOR";
    delete process.env[noColorKey];
    process.env.MU_FORCE_COLOR = "1";
    vi.resetModules();
  });
  afterEach(() => {
    if (savedNoColor === undefined) {
      const noColorKey = "NO_COLOR";
      delete process.env[noColorKey];
    } else {
      process.env.NO_COLOR = savedNoColor;
    }
    if (savedForceColor === undefined) {
      const forceColorKey = "MU_FORCE_COLOR";
      delete process.env[forceColorKey];
    } else {
      process.env.MU_FORCE_COLOR = savedForceColor;
    }
    vi.resetModules();
  });

  it("colours every verb in EVENT_VERB_PREFIXES", async () => {
    const { EVENT_VERB_PREFIXES } = await import("../src/logs.js");
    const { colorEventPayload } = await import("../src/cli/hud.js");
    expect(EVENT_VERB_PREFIXES.length).toBeGreaterThan(0);
    for (const verb of EVENT_VERB_PREFIXES) {
      const payload = `${verb} alpha (extra info)`;
      const out = colorEventPayload(payload);
      // Output must wrap `verb` in ANSI escapes (cyan) and leave the
      // tail intact. Two checks: (a) the verb is no longer present
      // verbatim at position 0 (escapes pushed it right) and (b) the
      // tail substring is still in the output.
      expect(out, `verb '${verb}' should be coloured`).not.toBe(payload);
      expect(out, `verb '${verb}' tail should survive`).toContain(" alpha (extra info)");
      // ANSI cyan SGR opener (\x1b[36m) must be present.
      expect(out, `verb '${verb}' should emit ANSI cyan`).toContain("\x1b[36m");
    }
  });

  it("leaves unknown payloads untouched (no false-positive matches)", async () => {
    const { colorEventPayload } = await import("../src/cli/hud.js");
    for (const payload of [
      "random freeform message",
      "approve granted slug", // wrong noun (`approve` vs `approval`) — must NOT match
      "snapshot capture foo", // not in the canonical list (snapshots.ts emits no events)
      "taskaddendum sneaky", // word-boundary check
    ]) {
      expect(colorEventPayload(payload)).toBe(payload);
    }
  });

  it("every emitEvent callsite under src/ uses a payload prefix in EVENT_VERB_PREFIXES", async () => {
    // Static-grep enforcement: scan src/**/*.ts for `emitEvent(`,
    // extract the first 1–2 leading tokens of the payload literal,
    // assert each is recognised. This is what catches drift in the
    // OTHER direction — a contributor adds a new emitter call but
    // forgets to extend EVENT_VERB_PREFIXES.
    const { EVENT_VERB_PREFIXES } = await import("../src/logs.js");
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join: pj } = await import("node:path");
    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = pj(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
      }
      return out;
    }
    const files = walk("src");
    // Capture the third arg to emitEvent across multi-line calls.
    // emitEvent(db, ws, `payload ...`, source?) — we want the third arg
    // (the payload), which is always a template literal or string
    // literal whose leading prefix we can sniff. Be lenient: just find
    // every backtick-or-quote literal that follows a `,` line under an
    // `emitEvent(` call.
    const callsites: { file: string; payloadPrefix: string }[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Match emitEvent(...) and pluck the first string/template literal
      // appearing as the third argument. emitEvent always takes
      // (db, workstream, payload, source?). Robust regex: look for
      // `emitEvent(` then skip up to two arg-separating commas, then
      // grab a backtick/single/double-quoted literal opener and read
      // until its closing delimiter.
      const re = /emitEvent\s*\(\s*[^,]+,\s*[^,]+,\s*([`'"])((?:\\.|(?!\1)[\s\S])*?)\1/g;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: classic regex loop
      while ((m = re.exec(src)) !== null) {
        const literal = m[2] ?? "";
        // Take the leading tokens up to the first ${ (template hole)
        // or whitespace-separated entity id. We need the first two
        // bare-word tokens (the verb prefix).
        const head = literal.split("${")[0] ?? "";
        const words = head.trim().split(/\s+/).slice(0, 2);
        if (words.length === 2) {
          callsites.push({ file, payloadPrefix: words.join(" ") });
        }
      }
    }
    expect(callsites.length).toBeGreaterThan(0);
    const knownPrefixes = new Set(EVENT_VERB_PREFIXES);
    // Special case: src/approvals.ts emits `approval ${newStatus} slug`
    // where newStatus is one of granted|denied|timeout. The regex
    // above will see the word `approval` followed by `${` and slice
    // off only one token — skip those (we have explicit list entries
    // approval granted/denied/timeout to cover them).
    const unknown = callsites.filter((c) => !knownPrefixes.has(c.payloadPrefix));
    expect(
      unknown,
      `emitEvent callsites with payload prefixes not in EVENT_VERB_PREFIXES: ${JSON.stringify(unknown, null, 2)}`,
    ).toEqual([]);
  });
});
