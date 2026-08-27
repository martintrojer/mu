// Historical op shapes remain readable after their command surface is removed.
// These intents carried prose payloads under otherwise projectable entities.
export const LEGACY_LOG_ONLY_INTENTS: ReadonlySet<string> = new Set(["workstream.export"]);

export function isLegacyLogOnlyIntent(intent: string | null): boolean {
  return intent !== null && LEGACY_LOG_ONLY_INTENTS.has(intent);
}
