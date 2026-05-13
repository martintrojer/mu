// Shared tiny state machine for VCS show drills (Commits and
// Workspaces popups). Keeps the previous successful body visible
// while a slow-tick refetch is in flight, avoiding the blank-flash
// flicker that came from clearing showText before each subprocess.
//
// Pure TS: no ink/react imports. Tests can drive the transition
// directly without mounting a popup or shelling out to git.

import type { ShowCommitResult, VcsBackend } from "../../../vcs.js";

export interface ShowLoaderState {
  text: string;
  error: string | null;
  loading: boolean;
}

export interface ShowLoaderSetters {
  setText: (text: string) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export type DetectBackendFn = (path: string) => Promise<Pick<VcsBackend, "showCommit">>;

export async function loadShowPreservingBody(
  path: string,
  sha: string,
  detect: DetectBackendFn,
  setters: ShowLoaderSetters,
): Promise<ShowCommitResult> {
  setters.setLoading(true);
  setters.setError(null);
  const backend = await detect(path);
  const result = await backend.showCommit(path, sha);
  if (result.error !== undefined) {
    setters.setError(result.error);
    setters.setText("");
  } else {
    setters.setText(result.text);
  }
  setters.setLoading(false);
  return result;
}
