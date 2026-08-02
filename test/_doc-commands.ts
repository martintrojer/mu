// Shared helper for the doc/CLI drift guard (test/docs-cli-drift.test.ts).
//
// WHY THIS EXISTS
//
// Two doc/code divergences in the 1.0 arc were caught by a human
// running a documented command, not by any test: VOCABULARY § portable
// omitted two tables, and `mu archive restore --source <ws>` kept
// documenting a flag that had become `-w`. Both are the same failure
// shape: prose that names a verb or flag the CLI no longer has. That is
// mechanically checkable, so it should not need a human.
//
// The check walks commander's OWN command tree rather than shelling out
// to `--help` per snippet: the tree is the same object the CLI parses
// with, it is ~200x faster than N subprocesses, and it keeps the guard
// in the fast tier.
//
// SCOPE, deliberately narrow: a documented command must NAME a real
// verb path and pass only KNOWN flags. It is not a semantic check —
// argument counts, value shapes, and mutually-exclusive combinations
// are the CLI's own job at runtime. A guard that tried to be a second
// parser would drift from the first one.

import type { Command } from "commander";

/** Marker an author puts on a fenced block or line whose `mu ...` text
 *  is illustrative (a shell alias, a future verb, a retired command being
 *  called out as REMOVED) and must not be parsed. A whole region is
 *  bracketed with `<!-- doc-cli-drift:skip-start -->` /
 *  `<!-- doc-cli-drift:skip-end -->` — that is the shape the
 *  "verbs we removed" and "things mu deliberately is not" sections
 *  need, since by construction every command in them is unknown. */
export const SKIP_MARKER = "doc-cli-drift:skip";
const SKIP_START = "doc-cli-drift:skip-start";
const SKIP_END = "doc-cli-drift:skip-end";

export interface DocCommand {
  /** Source file, repo-relative. */
  file: string;
  /** 1-based line number of the line the command was extracted from. */
  line: number;
  /** The command text, starting at `mu`. */
  text: string;
}

export interface DocCommandProblem extends DocCommand {
  reason: string;
}

/** Docs write optional arguments in markdown-ese: `mu archive restore
 *  <label> --as <ws> [--source <orig>]`. The brackets are notation, not
 *  shell, and the flag INSIDE them is exactly the drift shape that
 *  shipped `--source` past two reviewers — so unwrap them rather than
 *  skipping the line. `[-w <ws>]` and `[--json]` unwrap the same way. */
function unwrapOptionalBrackets(text: string): string {
  return text.replace(/\[([^\]]*)\]/g, (whole, inner: string) =>
    inner.trimStart().startsWith("-") ? inner : whole,
  );
}

/** Split a doc line's command text into shell-ish tokens, honouring
 *  single/double quotes so `--title 'a b'` is one token. Unterminated
 *  quotes just run to end of line — a doc snippet, not a shell. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** Pull every `mu ...` command out of a markdown file.
 *
 *  Two shapes are recognised, because the docs use both:
 *    - a line inside a fenced code block that starts with `mu `
 *    - an inline `` `mu ...` `` span in prose or a table cell
 *
 *  Skipped: any line (or any line inside a fenced block) carrying
 *  SKIP_MARKER, and any command whose text contains a shell
 *  metacharacter we would have to interpret to be right ($, `, |, etc).
 */
export function extractDocCommands(file: string, source: string): DocCommand[] {
  const out: DocCommand[] = [];
  const lines = source.split("\n");
  let inFence = false;
  let fenceSkipped = false;
  let inSkipRegion = false;

  const push = (line: number, raw: string): void => {
    const text = raw
      .trim()
      .replace(/[;&]+$/, "")
      .trim();
    if (!/^mu(\s|$)/.test(text)) return;
    if (text === "mu") return; // bare `mu` is the TUI, no verb to check
    out.push({ file, line, text });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const lineNo = i + 1;

    if (raw.includes(SKIP_START)) {
      inSkipRegion = true;
      continue;
    }
    if (raw.includes(SKIP_END)) {
      inSkipRegion = false;
      continue;
    }
    if (inSkipRegion) continue;

    const fence = raw.match(/^\s*```/);
    if (fence) {
      if (inFence) {
        inFence = false;
        fenceSkipped = false;
      } else {
        inFence = true;
        fenceSkipped = raw.includes(SKIP_MARKER);
      }
      continue;
    }

    if (raw.includes(SKIP_MARKER)) continue;

    if (inFence) {
      if (fenceSkipped) continue;
      // Strip a trailing `# comment`, then take the last segment of a
      // `cmd && mu ...` / `$(mu ...)`-free simple line.
      const stripped = raw.split(/\s+#\s/)[0] ?? raw;
      push(lineNo, stripped);
      continue;
    }

    // Inline `mu ...` spans in prose and tables.
    for (const m of raw.matchAll(/`(mu[^`]*)`/g)) {
      const text = m[1];
      if (text !== undefined) push(lineNo, text);
    }
  }

  return out;
}

/** Shell constructs whose meaning we would have to emulate. A snippet
 *  containing one is prose about shell plumbing, not a single mu
 *  invocation we can meaningfully validate.
 *
 *  NOTE the redirection patterns require SURROUNDING WHITESPACE. An
 *  earlier version listed bare `<` and `>`, which silently skipped
 *  every command containing a `<placeholder>` — i.e. almost all of
 *  them, including the `--source` row this guard exists to catch.
 *  Placeholders are the norm in docs; redirection is not. */
const UNCHECKABLE = /[$`|]|&&|\s[<>]\s|\.\.\.$|\bmu\b.*\bmu\b/;

interface Resolved {
  cmd: Command;
  /** tokens after the verb path */
  rest: string[];
}

function resolve(root: Command, tokens: string[]): Resolved {
  let cmd = root;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || tok.startsWith("-")) break;
    const sub = cmd.commands.find((c) => c.name() === tok || c.aliases().includes(tok));
    if (!sub) break;
    cmd = sub;
    i++;
  }
  return { cmd, rest: tokens.slice(i) };
}

function knownFlag(cmd: Command, flag: string): boolean {
  const name = flag.split("=")[0] ?? flag;
  if (name === "--help" || name === "-h") return true;
  for (let c: Command | null = cmd; c; c = c.parent) {
    for (const opt of c.options) {
      if (opt.short === name || opt.long === name) return true;
      // Commander records `--no-export` as long `--no-export`; also
      // accept the positive form a doc might write.
      if (opt.long?.startsWith("--no-") && `--${opt.long.slice(5)}` === name) {
        return true;
      }
    }
    // Only the root carries globals worth inheriting; stop otherwise.
  }
  return false;
}

/** Validate one extracted command against the commander tree.
 *  Returns a reason string when it does not parse, else null. */
export function checkDocCommand(root: Command, cmd: DocCommand): string | null {
  if (UNCHECKABLE.test(cmd.text)) return null;

  const tokens = tokenize(unwrapOptionalBrackets(cmd.text));
  if (tokens[0] !== "mu") return null;
  const args = tokens.slice(1);
  if (args.length === 0) return null;

  const { cmd: resolved, rest } = resolve(root, args);

  // `mu task close/reject/defer/release`: slash-enumerating sibling
  // verbs is a doc idiom, not a command. Only when the slash lands in
  // VERB position — `mu task show ws/id` is a real qualified positional,
  // and `mu db export/import/replay` still fails on `db`.
  if (rest[0]?.includes("/") && resolved.commands.length > 0) return null;

  // The first leftover token, if it is not a flag, is either a
  // positional or an unknown verb. Distinguish: a command with zero
  // registered arguments and at least one subcommand can only take a
  // verb there.
  const head = rest[0];
  if (head !== undefined && !head.startsWith("-")) {
    const takesPositional = resolved.registeredArguments.length > 0;
    if (!takesPositional && resolved.commands.length > 0) {
      // `mu <verb> --help` is metasyntax ABOUT the CLI. Only bail here,
      // where the token stands in for a verb name — not before the flag
      // loop, or `mu archive restore <label> --source x` would be
      // skipped for having a placeholder positional, which is the
      // exact drift this guard exists to catch.
      if (head.startsWith("<")) return null;
      return `unknown command '${head}' under '${resolved.name()}'`;
    }
  }

  for (const tok of rest) {
    if (!tok.startsWith("-") || tok === "-") continue;
    if (/^-\d/.test(tok)) continue; // negative number argument
    if (!knownFlag(resolved, tok)) {
      const path = [];
      for (let c: Command | null = resolved; c; c = c.parent) path.unshift(c.name());
      return `unknown option '${tok}' for '${path.join(" ")}'`;
    }
  }

  return null;
}
