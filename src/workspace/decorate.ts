// mu — workspace staleness and dirty decorators.

import type { Db } from "../db.js";
import { isWorkspaceStale } from "../staleness.js";
import { backendByName } from "../vcs.js";
import type { WorkspaceRow, WorkspaceStaleness } from "./core.js";
import { getWorkspaceForAgent } from "./crud.js";

const DECORATE_CONCURRENCY = 4;

export async function getWorkspaceStaleness(
  db: Db,
  agentName: string,
  workstreamName: string,
): Promise<WorkspaceStaleness | null> {
  const row = getWorkspaceForAgent(db, agentName, workstreamName);
  if (row === undefined) return null;
  const [decorated] = await decorateWithStaleness([row]);
  const commitsBehindMain = decorated?.commitsBehindMain ?? null;
  return {
    agentName,
    workstreamName,
    commitsBehindMain,
    isStale: isWorkspaceStale(commitsBehindMain),
  };
}

/**
 * Decorate each row with `commitsBehindMain` by asking the row's backend
 * how far the parent_ref is behind the project's default branch HEAD.
 * Cheap, pure observation: NO automatic `git fetch` / `jj git fetch` /
 * `sl pull`. The number is as fresh as the workspace's local refs cache.
 *
 * Returns a NEW array; does not mutate the input. Rows whose parent_ref
 * is missing, or whose backend's commitsBehind throws / returns null,
 * get `commitsBehindMain: null`.
 */
export async function decorateWithStaleness(
  rows: readonly WorkspaceRow[],
): Promise<WorkspaceRow[]> {
  const cache = new Map<string, Promise<number | null>>();
  const fetchBehind = (r: WorkspaceRow): Promise<number | null> => {
    const parentRef = r.parentRef;
    if (parentRef === null) return Promise.resolve(null);
    const key = `${r.backend}\x00${parentRef}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const p = (async (): Promise<number | null> => {
      try {
        const backend = backendByName(r.backend);
        return await backend.commitsBehind(r.path, parentRef);
      } catch {
        return null;
      }
    })();
    cache.set(key, p);
    return p;
  };
  return mapWithConcurrency(rows, DECORATE_CONCURRENCY, async (r) => ({
    ...r,
    commitsBehindMain: await fetchBehind(r),
  }));
}

/**
 * Decorate every row with a `dirty` marker — true when the backend's
 * `listDirtyFiles` reports any uncommitted / unstaged / untracked-not-
 * ignored files; false when clean; null on backend-command failure.
 *
 * Returns a NEW array; does not mutate the input.
 */
export async function decorateWithDirty(rows: readonly WorkspaceRow[]): Promise<WorkspaceRow[]> {
  return mapWithConcurrency(rows, DECORATE_CONCURRENCY, async (r) => {
    let dirty: boolean | null;
    try {
      const backend = backendByName(r.backend);
      const files = await backend.listDirtyFiles(r.path);
      dirty = files.length > 0;
    } catch {
      dirty = null;
    }
    return { ...r, dirty };
  });
}

/**
 * Tiny p-limit-style helper. Keeps at most `limit` callbacks in flight
 * at once and preserves input order in the result. Stays in this file
 * because it has exactly two local decorator callers; promote out only
 * when a second cluster needs it.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  };
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
