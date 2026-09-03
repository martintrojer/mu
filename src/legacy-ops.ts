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
/**
 * Intents renamed after ops carrying the old name were already on
 * disk. Key = current name, value = every historical spelling.
 *
 * The op log is append-only, so a rename cannot rewrite history: the
 * old string stays on the rows it was written to, forever. Everything
 * that READS by intent therefore has to accept both, or a rename
 * silently truncates the user's history at the release boundary —
 * `mu log --intent <new>` would miss every pre-rename op and
 * `mu undo` would not find those groups.
 *
 * `workstream.destroy` became `workstream.teardown` in 1.1.2 because
 * "destroy" claims irreversibility that is not true (tombstones are
 * written; `mu undo` restores the rows) and operators were hoarding
 * pre-flight DB copies because of it. ~5k ops carry the old name.
 */
export const LEGACY_INTENT_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ["workstream.teardown", ["workstream.destroy"]],
]);

/** Every spelling of `intent`, current first. A single-element list for
 *  the common case of an intent that was never renamed. */
export function intentSpellings(intent: string): readonly string[] {
  const legacy = LEGACY_INTENT_SYNONYMS.get(intent);
  return legacy === undefined ? [intent] : [intent, ...legacy];
}

export const LEGACY_LOG_ONLY_SQL_EXCLUSION: string = `(intent IS NULL OR intent NOT IN (${[
  ...LEGACY_LOG_ONLY_INTENTS,
]
  .map((i) => `'${i}'`)
  .join(", ")}))`;
