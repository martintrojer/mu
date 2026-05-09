#!/usr/bin/env bash
# scripts/grep-v4-references.sh
#
# CI guard: src/ must not mention "v4" or "backward-compat" (or
# "backward compat") any more. The v4 schema was a one-shot migration
# concern; once `schema_v5_drop_migrations_ts` deleted the in-process
# migration ladder and v5_prune_v4_fallback_branches deleted every
# "preserves the v4 contract" fallback branch, those words are zombie
# vocabulary. A reader who sees "v4" in current source assumes a
# fallback path exists; this guard makes such ghosts impossible.
#
# What's allowed:
#   - The migration script and its callers (src/db.ts mentions
#     scripts/migrate-v4-to-v5.ts as the operator's escape hatch out
#     of a pre-v5 DB; that's the only legitimate "v4" reference).
#   - Strings inside CHANGELOG.md / docs/ — historical artifacts
#     describing how we got here. This guard scans src/ only.
#
# Allow-list lives at scripts/grep-v4-references.allowlist
# (one path:lineno per allow-listed line, comments OK).
#
# Usage:
#   scripts/grep-v4-references.sh
#
# Exit codes:
#   0  — no offending mentions
#   1  — at least one offender; the script prints them with a hint

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOW_FILE="$ROOT/scripts/grep-v4-references.allowlist"

# Match: word-boundary 'v4' OR 'backward-compat' OR 'backward compat'
# Case-sensitive on the v4 token (we don't want to flag a future "V4"
# in an unrelated context); case-insensitive on the compat phrase.
RG=$(command -v rg || true)
if [[ -n "$RG" ]]; then
  RAW=$("$RG" --no-heading --line-number \
        -e '\bv4\b' \
        -e '(?i)backward[- ]compat' \
        src/ || true)
else
  # POSIX grep: word boundaries are awkward; approximate with the
  # boundary char-class.
  RAW=$(grep -rn -E '(^|[^a-zA-Z0-9_])v4($|[^a-zA-Z0-9_])|[Bb]ackward[- ][Cc]ompat' src/ || true)
fi

# Apply allow-list (path:lineno tokens).
ALLOW_KEYS=""
if [[ -f "$ALLOW_FILE" ]]; then
  ALLOW_KEYS=$(grep -v '^#' "$ALLOW_FILE" | grep -v '^[[:space:]]*$' || true)
fi

OFFENDERS=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  pathline="${line%%:*}:$(echo "$line" | awk -F: '{print $2}')"
  matched_allow=0
  while IFS= read -r allow; do
    [[ -z "$allow" ]] && continue
    if [[ "$pathline" == "$allow" ]]; then
      matched_allow=1
      break
    fi
  done <<< "$ALLOW_KEYS"
  if [[ "$matched_allow" -eq 0 ]]; then
    OFFENDERS+="$line"$'\n'
  fi
done <<< "$RAW"
OFFENDERS="${OFFENDERS%$'\n'}"

if [[ -n "$OFFENDERS" ]]; then
  echo "ERROR: v5_prune_v4_fallback_branches guard caught a v4 reference in src/:" >&2
  echo "$OFFENDERS" >&2
  echo "" >&2
  echo "Pre-1.0 mu has no v4 fallback paths. The schema migration ladder is gone;" >&2
  echo "the loud-fail hook in openDb refuses any pre-v5 DB. A 'v4' or 'backward-compat'" >&2
  echo "comment in src/ misleads readers into thinking a fallback path exists." >&2
  echo "" >&2
  echo "Fix one of:" >&2
  echo "  - Delete the comment + the dead branch (the cleanup pattern)." >&2
  echo "  - Rephrase to describe the CURRENT behaviour without the v4 framing." >&2
  echo "  - If the reference is the migration-script docstring (one canonical line in" >&2
  echo "    src/db.ts), add it to scripts/grep-v4-references.allowlist with a comment." >&2
  exit 1
fi

echo "OK: no v4 / backward-compat mentions in src/ (v5_prune_v4_fallback_branches guard)."
exit 0
