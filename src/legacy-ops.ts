// Historical op shapes remain readable after their command surface is removed.
// These intents carried prose payloads under otherwise projectable entities.
export const LEGACY_LOG_ONLY_INTENTS: ReadonlySet<string> = new Set(["workstream.export"]);

export function isLegacyLogOnlyIntent(intent: string | null): boolean {
  return intent !== null && LEGACY_LOG_ONLY_INTENTS.has(intent);
}

/**
 * The same exclusion as a SQL predicate, for queries that must not even
 * TOUCH these rows.
 *
 * A JS-side filter is not always enough: SQLite's `json_type` /
 * `json_extract` raise `malformed JSON` while STEPPING, so a query that
 * merely evaluates a json function over one of these prose payloads
 * fails before any row reaches JS. Callers that read payloads by key
 * therefore have to exclude them in the WHERE clause.
 *
 * Kept next to the set it derives from so the two can never disagree.
 * Emitted as a literal rather than a bound parameter because it is
 * interpolated into prepared SQL; every member is a fixed identifier in
 * this file, never operator input.
 */
export const LEGACY_LOG_ONLY_SQL_EXCLUSION: string = `(intent IS NULL OR intent NOT IN (${[
  ...LEGACY_LOG_ONLY_INTENTS,
]
  .map((i) => `'${i}'`)
  .join(", ")}))`;
