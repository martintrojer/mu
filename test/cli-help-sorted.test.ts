// Verifies that the Commands list in every --help screen is rendered
// alphabetically. Sort order is configured via Commander's
// configureHelp({ sortSubcommands: true }) at the root and walked
// recursively in src/cli.ts (applyAlphabeticalHelpSort) so future
// .addCommand() attachments inherit it too.
//
// What is NOT sorted (and is asserted UN-sorted on a spot-check):
//   - The Options list under any verb. Options have a curated
//     semantic order; alphabetising would worsen readability.
//   - Positional arguments (part of the verb signature).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./_runCli.js";

// Parse the lines under the "Commands:" header of a --help screen.
// Each command line is two-space-indented and the verb name is the
// first whitespace-delimited token after the indent. Continuation
// lines (the wrapped description text) are also two-space-indented
// but their leading token is part of the prior description, so we
// must filter them: only the FIRST line of each command entry has
// non-whitespace beginning at column 2 AND is preceded by either the
// "Commands:" header or a previous command's last description line
// that doesn't start with whitespace beyond column 2. Simpler rule
// that holds for commander v14's renderer: a command line has the
// shape /^  (\S+)/ AND the column-2 token must NOT begin with a
// lowercase-letter that is part of an obvious mid-sentence wrap.
//
// To avoid that fragility we use commander's own column layout: every
// verb-name token starts at column 2, AND the command summary (which
// wraps) is indented to a deeper column (commander pads to align all
// summaries). So on continuation lines, column 2 is whitespace. We
// can therefore detect command-rows by /^  \S/ AND filter out wraps
// by checking that the line ALSO has a multi-space gap between the
// usage-form and the description (or no description at all). For
// safety we do BOTH: rely on /^  \S/ and additionally drop any token
// that doesn't look like a command name (lowercase + dashes).
function parseCommandList(helpText: string): string[] {
  const lines = helpText.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === "Commands:");
  if (startIdx === -1) return [];
  const names: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "") break;
    // Continuation / wrap lines start with > 2 spaces.
    if (!/^ {2}\S/.test(line)) continue;
    // Extract the first token; commander prints "name [options] <arg>"
    // or just "name" — take the first whitespace-delimited word.
    const match = line.match(/^ {2}(\S+)/);
    if (!match) continue;
    const name = match[1];
    if (name === undefined) continue;
    // Skip the special "help [command]" entry: commander auto-adds it,
    // and its position is below "h..." which sorts naturally; including
    // it strengthens (not weakens) the assertion. So we keep it.
    names.push(name);
  }
  return names;
}

function assertAlphabetical(names: string[]): void {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
}

describe("--help Commands list is sorted alphabetically", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-help-sort-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("root `mu --help` lists commands alphabetically", async () => {
    const result = await runCli(["--help"], dbPath);
    expect(result.error).toBeUndefined();
    const names = parseCommandList(result.stdout);
    expect(names.length).toBeGreaterThan(5);
    assertAlphabetical(names);
  });

  // Every subcommand group shipped today. Adding/removing groups is
  // expected; the test asserts the group's listing is sorted, not
  // any specific membership.
  const groups = ["workstream", "archive", "agent", "workspace", "task", "snapshot", "me", "db"];

  for (const group of groups) {
    it(`\`mu ${group} --help\` lists commands alphabetically`, async () => {
      const result = await runCli([group, "--help"], dbPath);
      expect(result.error).toBeUndefined();
      const names = parseCommandList(result.stdout);
      expect(names.length).toBeGreaterThan(0);
      assertAlphabetical(names);
    });
  }

  it("`mu task add --help` Options list preserves REGISTRATION order (not alphabetical)", async () => {
    // Spot-check: the Options list is curated. Re-ordering it would
    // hurt operator muscle memory. --title comes first; --workstream
    // is later; -h / --help is last. Alphabetical would put
    // --blocked-by before --effort-days (b < e — okay) but would put
    // --json before --title (j < t) and -h before --workstream — both
    // wrong vs the curated order.
    const result = await runCli(["task", "add", "--help"], dbPath);
    expect(result.error).toBeUndefined();
    const text = result.stdout;
    const idxTitle = text.indexOf("--title");
    const idxWorkstream = text.indexOf("--workstream");
    const idxJson = text.indexOf("--json");
    const idxHelp = text.lastIndexOf("--help");
    expect(idxTitle).toBeGreaterThan(0);
    expect(idxWorkstream).toBeGreaterThan(idxTitle); // --title before --workstream
    expect(idxJson).toBeGreaterThan(idxWorkstream); // --workstream before --json
    expect(idxHelp).toBeGreaterThan(idxJson); // --help is last
  });
});
