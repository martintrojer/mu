// The doc/CLI drift guard.
//
// Every `mu ...` command written in the docs must name a real verb and
// pass only real flags. See test/_doc-commands.ts for why this is a
// tree walk rather than N `--help` subprocesses, and for the escape
// hatch (SKIP_MARKER) an author uses on an illustrative snippet.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { type DocCommandProblem, checkDocCommand, extractDocCommands } from "./_doc-commands.js";

const ROOT = join(import.meta.dirname, "..");

/** Docs whose `mu` snippets are load-bearing instructions.
 *  Deliberately excludes CHANGELOG.md: it is a historical record and
 *  MUST keep naming removed verbs, so a skip region per release entry
 *  would be pure noise. ROADMAP.md IS checked — its live sections are
 *  instructions — with its one superseded section bracketed by the
 *  skip markers. */
const DOC_FILES = [
  "README.md",
  "AGENTS.md",
  "docs/USAGE_GUIDE.md",
  "docs/VOCABULARY.md",
  "docs/ARCHITECTURE.md",
  "docs/VISION.md",
  "docs/ROADMAP.md",
  "docs/HANDOVER.md",
  "skills/mu/SKILL.md",
  "scripts/README.md",
];

describe("docs name only real CLI surface", () => {
  const program = buildProgram();

  it("extracts a non-trivial number of commands (the guard is actually looking)", () => {
    let total = 0;
    for (const file of DOC_FILES) {
      total += extractDocCommands(file, readFileSync(join(ROOT, file), "utf8")).length;
    }
    expect(total).toBeGreaterThan(500);
  });

  // A guard that cannot fail is theatre. Plant each drift shape the
  // 2.0 arc actually produced and assert it is named.
  it.each([
    // `db` SURVIVES as a namespace (v2 R17 wired `mu db backup`), so the
    // guard names the missing SUBCOMMAND rather than the namespace. That
    // is the more precise message, and asserting it here pins the
    // distinction: a removed subverb under a live namespace must still
    // be caught.
    [
      "a removed subverb under a live namespace",
      "`mu db export /tmp/x.db`",
      "unknown command 'export' under 'db'",
    ],
    ["a removed subverb", "`mu snapshot list`", "unknown command 'snapshot'"],
    ["a renamed flag", "`mu archive restore v1 --source old`", "unknown option '--source'"],
    ["a flag removed from a live verb", "`mu undo --to 12`", "unknown option '--to'"],
    // THE case that shipped past two reviewers: the dead flag was
    // inside markdown optional-brackets, so a naive extractor skips it.
    [
      "a renamed flag inside markdown optional-brackets",
      "| Lossless un-archive | `mu archive restore <l> --as <new> [--source <orig>]` |",
      "unknown option '--source'",
    ],
  ])("detects %s", (_label, snippet, expected) => {
    const found = extractDocCommands("fixture.md", snippet);
    expect(found).toHaveLength(1);
    const first = found[0];
    if (!first) throw new Error("unreachable");
    expect(checkDocCommand(program, first)).toContain(expected);
  });

  it("honours the skip region so historical sections can name dead verbs", () => {
    const src = [
      "<!-- doc-cli-drift:skip-start -->",
      "`mu db export /tmp/x.db`",
      "<!-- doc-cli-drift:skip-end -->",
      "`mu task list`",
    ].join("\n");
    const found = extractDocCommands("fixture.md", src);
    expect(found.map((c) => c.text)).toEqual(["mu task list"]);
  });

  for (const file of DOC_FILES) {
    it(`${file} has no unknown verbs or flags`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      const problems: DocCommandProblem[] = [];
      for (const cmd of extractDocCommands(file, source)) {
        const reason = checkDocCommand(program, cmd);
        if (reason) problems.push({ ...cmd, reason });
      }
      const rendered = problems.map((p) => `${p.file}:${p.line}: ${p.reason}\n    ${p.text}`);
      expect(rendered).toEqual([]);
    });
  }
});
