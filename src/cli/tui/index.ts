import type { Db } from "../../db.js";

export interface RunTuiOptions {
  workstream: string;
}

// Real signature lands in Task 22 (Wave 4); for now this is a placeholder
// so the dispatch branch in cmdState (Task 15) has something to dynamic-import.
export async function runTui(_db: Db, _opts: RunTuiOptions): Promise<void> {
  throw new Error("runTui: not implemented yet");
}
