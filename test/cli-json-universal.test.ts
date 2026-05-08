// Regression test: every program.command() in src/cli.ts accepts --json.
//
// Skill cleanup (selfdoc_skill_cleanup) wants to assert "every mu verb
// supports --json" in SKILL.md. This test guards that invariant against
// drift: adding a new verb without --json breaks the build.
//
// Implementation: parse src/cli.ts for every .command(...) ... .action(...)
// block and assert each block contains either JSON_OPT or a literal
// "--json" option. Subcommand-group registrations (no .action()) are
// skipped automatically because the block boundary requires .action().

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..");
const CLI_PATH = join(REPO_ROOT, "src/cli.ts");

/**
 * Verbs that legitimately don't need --json. Document the reason here;
 * each entry should be argued for, not just allowlisted to silence the
 * test. Empty list = every verb has --json.
 *
 * Current allowlist:
 *   - "attach <name>": prints scrollback + a `tmux attach` command for
 *     the human to copy-paste; no machine-actionable output.
 *
 * If you're tempted to add a new entry, ask: does this verb have NO
 * meaningful output a script would want? If unsure, add --json instead.
 */
const ALLOWLIST: ReadonlySet<string> = new Set(["attach <name>"]);

describe("--json is universal across mu CLI verbs", () => {
  const src = readFileSync(CLI_PATH, "utf8");

  // Match each .command(...)<...>.action() block. Non-greedy on the
  // body so adjacent commands don't bleed.
  const blockRe = /\.command\(\s*"([^"]+)"\s*\)([\s\S]*?)\.action\(/g;

  const verbs: Array<{ name: string; hasJson: boolean }> = [];
  let m: RegExpExecArray | null = blockRe.exec(src);
  while (m !== null) {
    const name = m[1] ?? "";
    const body = m[2] ?? "";
    const hasJson = body.includes("JSON_OPT") || body.includes('"--json"');
    verbs.push({ name, hasJson });
    m = blockRe.exec(src);
  }

  it("found a non-trivial number of verbs (sanity check on the regex)", () => {
    expect(verbs.length).toBeGreaterThan(20);
  });

  it("every verb accepts --json (or is in the documented allowlist)", () => {
    const missing = verbs.filter((v) => !v.hasJson && !ALLOWLIST.has(v.name));
    if (missing.length > 0) {
      const names = missing.map((v) => `  - mu ... ${v.name}`).join("\n");
      throw new Error(
        `These verbs are missing --json (add JSON_OPT or document in test/cli-json-universal.test.ts ALLOWLIST with reason):\n${names}`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("allowlist entries actually exist as verbs (catches stale allowlist drift)", () => {
    const verbNames = new Set(verbs.map((v) => v.name));
    for (const allowed of ALLOWLIST) {
      expect(verbNames.has(allowed)).toBe(true);
    }
  });
});
