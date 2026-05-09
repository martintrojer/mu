#!/usr/bin/env bash
# scripts/grep-name-without-workstream.sh
#
# CI guard for bug_v5_name_clash_silent_misroute.
#
# Post-v5 every entity table (tasks / agents / approvals) has TEXT
# names that are unique only within a workstream. A bare
# `WHERE local_id = ?` / `WHERE name = ?` / `WHERE slug = ?` SELECT
# can silently pick the wrong workstream's row when the same name
# exists in multiple workstreams.
#
# This script scans src/ for any line that filters by `local_id`,
# `slug`, or an entity (non-workstream) `name` column without ALSO
# scoping by `workstream_id` somewhere in the same prepared
# statement. Lines that legitimately fall back to the v4 "no
# workstream context" SDK contract (each one inside an
# `if (workstream !== undefined)`-gated branch with the scoped
# alternate sitting next to it) are listed in the allowlist file.
#
# Usage:
#   scripts/grep-name-without-workstream.sh
#
# Exit codes:
#   0  — no offending lines
#   1  — at least one offender; the script prints the matching lines
#        and a hint pointing at the typed fix path

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOW_FILE="$ROOT/scripts/grep-name-without-workstream.allowlist"

# Per-prepared-statement scan: split each .ts file into the textual
# arguments to db.prepare("…") and inspect those substrings, not raw
# lines. The prepare() argument is a single JS template/string literal
# that may span many lines; checking it as a unit lets multi-line SQL
# (`WHERE local_id = ?\n  AND workstream_id = ...`) pass cleanly while
# bare single-line WHERE clauses still trip.
#
# Implementation: pure node. ts files are small enough that a regex
# walk per file is sub-second. We deliberately avoid pulling in a
# JS/TS parser dep — the grep-guard is supposed to be substrate-light.

node - <<'NODE_EOF'
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const ALLOW_FILE = path.join(ROOT, "scripts/grep-name-without-workstream.allowlist");

const allow = new Set();
if (fs.existsSync(ALLOW_FILE)) {
  for (const raw of fs.readFileSync(ALLOW_FILE, "utf8").split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    allow.add(t);
  }
}

// Walk src/ for *.ts files.
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(p);
  }
}
const files = [];
walk(SRC, files);

// Find every db.prepare(...) call. The argument can be:
//   - a plain string:  db.prepare("SELECT ...")
//   - a template literal with ${...} substitutions:
//       db.prepare(`SELECT ${COLS} FROM tasks WHERE local_id = ?`)
// A single regex over the source can't do balanced matching against
// the closing backtick when ${...} substitutions also use backticks.
// We do a streaming scan: locate `.prepare(`, skip whitespace, then
// read the string literal honouring quote/template nesting.
function findPrepareCalls(text) {
  const out = [];
  let i = 0;
  while (true) {
    const idx = text.indexOf(".prepare(", i);
    if (idx < 0) return out;
    let p = idx + ".prepare(".length;
    while (p < text.length && /\s/.test(text[p])) p++;
    const open = text[p];
    if (open !== '"' && open !== "'" && open !== "`") {
      i = idx + 1;
      continue;
    }
    const start = p;
    p++;
    let body = "";
    let closed = false;
    while (p < text.length) {
      const c = text[p];
      if (c === "\\") {
        body += text.slice(p, p + 2);
        p += 2;
        continue;
      }
      if (open === "`" && c === "$" && text[p + 1] === "{") {
        // Skip balanced ${...}.
        let depth = 1;
        p += 2;
        body += "${";
        while (p < text.length && depth > 0) {
          const cc = text[p];
          if (cc === "{") depth++;
          else if (cc === "}") depth--;
          if (depth > 0) body += cc;
          p++;
        }
        body += "}";
        continue;
      }
      if (c === open) {
        closed = true;
        p++;
        break;
      }
      body += c;
      p++;
    }
    if (closed) {
      out.push({ index: start, body });
      i = p;
    } else {
      i = idx + 1;
    }
  }
}

// A SQL fragment is "an offender" if it filters by local_id / slug /
// an entity (non-workstream-table) `name` column and DOES NOT also
// filter by workstream_id anywhere in the same fragment.
function isOffender(sql) {
  const lower = sql.toLowerCase();
  // Special case 1: queries against the workstreams table itself — the
  // table doesn't HAVE a workstream_id column. Skip those (the
  // workstream's own TEXT name is globally unique by definition).
  // Detect via FROM / UPDATE / DELETE FROM / INTO targeting
  // workstreams (with no other entity table in the FROM list).
  const targetsWorkstreamsTableOnly =
    /\b(from|update|into|delete\s+from)\s+workstreams\b/.test(lower) &&
    !/\b(from|join)\s+(tasks|agents|approvals|task_edges|task_notes|agent_logs|vcs_workspaces|snapshots)\b/.test(
      lower,
    );
  if (targetsWorkstreamsTableOnly) return false;
  // Strip the canonical resolver shapes that are by-design
  // workstream-scoped:
  //   - `ws.name = ?` / `workstreams.name = ?` (the JOIN-resolver path)
  //   - the workstream-id sub-resolver subselect
  //     `workstream_id = (SELECT id FROM workstreams WHERE name = ?)`
  //     already implies a workstream_id filter for the outer statement.
  const stripped = lower
    // `ws.name = ?` and `workstreams.name = ?` ARE the workstream
    // scope: replace them with a marker that the workstream-id check
    // below recognises.
    .replace(/\bws\.name\s*=\s*\?/g, "workstream_id_resolver")
    .replace(/\bworkstreams\.name\s*=\s*\?/g, "workstream_id_resolver")
    .replace(/\bworkstream_id\s*=\s*\(\s*select[\s\S]*?\)/g, "workstream_id_resolver");
  // If the fragment, after stripping, no longer contains a WHERE on
  // any TEXT name (local_id / slug / name), it's not in scope.
  const filtersByName =
    /\bwhere\b[\s\S]*?\b(?:[a-z]+\.)?(local_id|slug)\s*=\s*\?/.test(stripped) ||
    /\bwhere\b[\s\S]*?\b(?:[a-z]+\.)?name\s*=\s*\?/.test(stripped);
  if (!filtersByName) return false;
  // Now check whether the fragment ALSO scopes by workstream_id.
  const hasWsId =
    /\bworkstream_id\s*=\s*\?/.test(stripped) ||
    /\bworkstream_id\s+is\s+null/.test(stripped) ||
    /\bworkstream_id_resolver\b/.test(stripped);
  return !hasWsId;
}

const offenders = [];
// Identifier for an offender / allow-list entry: `<file>::<sql>` where
// SQL is whitespace-normalised to one line. Line-number-based keys are
// brittle (Biome reformats can shift them); the SQL itself is the
// stable thing to point at.
function normaliseSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const call of findPrepareCalls(text)) {
    const sql = call.body;
    const startLine = text.slice(0, call.index).split("\n").length;
    const rel = path.relative(ROOT, file);
    const oneLine = normaliseSql(sql);
    const key = `${rel}::${oneLine}`;
    if (allow.has(key)) continue;
    if (isOffender(sql)) {
      const truncated = oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
      offenders.push({ display: `${rel}:${startLine}`, key, sql: truncated });
    }
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    "ERROR: bug_v5_name_clash_silent_misroute guard caught unscoped name lookups in src/:\n",
  );
  for (const o of offenders) {
    process.stderr.write(`  ${o.display}  ${o.sql}\n`);
  }
  process.stderr.write(
    "\nAllow-list entry shape (one per line in scripts/grep-name-without-workstream.allowlist):\n",
  );
  for (const o of offenders) {
    process.stderr.write(`  ${o.key}\n`);
  }
  process.stderr.write("\n");
  process.stderr.write(
    "Each match is a SELECT/UPDATE/DELETE that filters by a TEXT name (local_id, slug, or\n",
  );
  process.stderr.write(
    "an agent's name) WITHOUT also scoping by workstream_id. v5 makes those names\n",
  );
  process.stderr.write(
    "per-workstream unique - a bare LIMIT 1 silently picks an arbitrary workstream's row.\n",
  );
  process.stderr.write("\n");
  process.stderr.write("Fix one of:\n");
  process.stderr.write(
    "  - Pass the workstream into the helper and add 'AND workstream_id = ?' to the SQL.\n",
  );
  process.stderr.write(
    "  - Use the typed resolver: resolveTaskId / resolveAgentId / tryResolveWorkstreamId.\n",
  );
  process.stderr.write(
    "  - If this is an intentional v4 fall-back inside a workstream-gated branch,\n",
  );
  process.stderr.write(
    "    add the path:lineno to scripts/grep-name-without-workstream.allowlist with a\n",
  );
  process.stderr.write("    comment explaining why the call is safe.\n");
  process.exit(1);
}

process.stdout.write(
  "OK: no unscoped name lookups in src/ (bug_v5_name_clash_silent_misroute guard).\n",
);
NODE_EOF
