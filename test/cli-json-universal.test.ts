// Regression test: every program.command() in src/cli.ts accepts --json.
//
// Skill cleanup wants to assert "every mu verb supports --json" in
// SKILL.md. This test guards that invariant against drift: adding a
// new verb without --json breaks the build.
//
// Implementation: drive the actual buildProgram() output and walk the
// commander tree recursively. Replaces an earlier regex-on-source
// audit (review_test_json_universal_regex_drift) which had three
// known false-positive paths:
//   1. Verbs nested under a parent command whose body absorbed the
//      regex match.
//   2. Verbs that build --json via a helper named differently from
//      `JSON_OPT` or the literal "--json".
//   3. Renaming the JSON_OPT identifier silently broke the audit
//      without breaking the audited behaviour.
//
// The new walk asserts on commander's actual parsed option list — the
// invariant we ACTUALLY care about ("commander accepts --json on this
// verb") rather than a textual proxy.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

/**
 * Verbs that legitimately don't need --json. Document the reason here;
 * each entry should be argued for, not just allowlisted to silence the
 * test. Empty list = every verb has --json.
 *
 * Allowlist key is the leaf command name (the first argument to
 * .command(), e.g. "attach <name>").
 *
 * Current allowlist:
 *   - "attach <name>": prints scrollback + a `tmux attach` command for
 *     the human to copy-paste; no machine-actionable output.
 *
 * If you're tempted to add a new entry, ask: does this verb have NO
 * meaningful output a script would want? If unsure, add --json instead.
 */
const ALLOWLIST: ReadonlySet<string> = new Set(["attach <name>"]);

interface VerbInfo {
  /** The full path: ["task", "add <id>"] for `mu task add`. */
  path: string[];
  /** Leaf command name, what .command() was called with. */
  name: string;
  /** True iff commander parses --json on this command. */
  hasJson: boolean;
  /** True iff this command has its own .action() (i.e. is a leaf
   *  verb, not just a group). */
  hasAction: boolean;
}

/** Recursively collect every command in the program tree. */
function collectVerbs(cmd: Command, parents: string[]): VerbInfo[] {
  const out: VerbInfo[] = [];
  for (const sub of cmd.commands) {
    const name = sub.name();
    // Reconstruct the .command() argument string by joining name +
    // any required/optional args. commander stores these in
    // sub.registeredArguments (better-sqlite-style metadata).
    // Fallback: just the name.
    const argSuffix = sub.registeredArguments
      .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
      .join(" ");
    const fullName = argSuffix ? `${name} ${argSuffix}` : name;
    const path = [...parents, fullName];
    // Leaf detection: a command is a leaf if it has no subcommands.
    // Group commands (`mu task`, `mu agent`, etc.) carry only
    // subcommands; leaves have actions but no children.
    // (commander's _actionHandler isn't reliable: groups may have a
    // default helpAction registered automatically.)
    const hasAction = sub.commands.length === 0;
    const hasJson = sub.options.some((o) => o.long === "--json");
    out.push({ path, name: fullName, hasJson, hasAction });
    if (sub.commands.length > 0) {
      out.push(...collectVerbs(sub, path));
    }
  }
  return out;
}

describe("--json is universal across mu CLI verbs", () => {
  const program = buildProgram();
  const verbs = collectVerbs(program, []);
  const leafVerbs = verbs.filter((v) => v.hasAction);

  it("found a non-trivial number of leaf verbs (sanity check on the walker)", () => {
    expect(leafVerbs.length).toBeGreaterThan(20);
  });

  it("every leaf verb accepts --json (or is in the documented allowlist)", () => {
    const missing = leafVerbs.filter((v) => !v.hasJson && !ALLOWLIST.has(v.name));
    if (missing.length > 0) {
      const names = missing.map((v) => `  - mu ${v.path.join(" ")}`).join("\n");
      throw new Error(
        `These leaf verbs are missing --json (add JSON_OPT or document in test/cli-json-universal.test.ts ALLOWLIST with reason):\n${names}`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("allowlist entries actually exist as leaf verbs (catches stale allowlist drift)", () => {
    const leafNames = new Set(leafVerbs.map((v) => v.name));
    for (const allowed of ALLOWLIST) {
      expect(
        leafNames.has(allowed),
        `allowlist entry '${allowed}' doesn't match any current leaf verb. Drop it from ALLOWLIST or fix the name.`,
      ).toBe(true);
    }
  });

  it("group commands without an .action() are not enforced (only leaves are)", () => {
    // Sanity: there should exist at least one group command (e.g.
    // 'task', 'agent') that has subcommands and no .action() of its
    // own. The test correctly skips these.
    const groups = verbs.filter((v) => !v.hasAction);
    expect(groups.length).toBeGreaterThan(0);
  });
});
