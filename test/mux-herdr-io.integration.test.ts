// herdr IO against a REAL herdr server.
//
// SELF-SKIPS unless `MU_HERDR_SESSION` names a herdr session whose
// server already reports running + compatible. It never starts, stops,
// or deletes a server, and never touches the DEFAULT session: the
// isolated session is the operator's to provide, e.g.
//
//   herdr --session mu-iotest server &
//   MU_HERDR_SESSION=mu-iotest npm run test -- mux-herdr-io.integration
//
// The fast tier excludes this file by suffix.

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capturePane, resetHerdrExecutor, sendToPane } from "../src/mux/herdr.js";

const SESSION = process.env.MU_HERDR_SESSION;
/** Refuse the default session outright — a stray create/close there
 *  would land in the user's real panes. */
const CANDIDATE = SESSION !== undefined && SESSION.length > 0 ? SESSION : undefined;

async function herdrCli(args: readonly string[]): Promise<{ stdout: string; ok: boolean }> {
  if (CANDIDATE === undefined) return { stdout: "", ok: false };
  const r = await execa("herdr", ["--session", CANDIDATE, ...args], { reject: false }).catch(
    () => undefined,
  );
  if (r === undefined) return { stdout: "", ok: false };
  return { stdout: r.stdout ?? "", ok: r.exitCode === 0 };
}

function readResult(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) return {};
  const inner = (parsed as { result?: unknown }).result;
  return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : {};
}

let ready = false;
let workspaceId: string | undefined;
let paneId: string | undefined;

beforeAll(async () => {
  if (CANDIDATE === undefined) return;
  const status = await herdrCli(["status"]);
  if (!status.ok) return;
  if (!/^\s*status:\s*running\s*$/m.test(status.stdout)) return;
  if (/^\s*compatible:\s*no\s*$/m.test(status.stdout)) return;
  ready = true;

  const label = `mu-iotest-${process.pid}-${Date.now()}`;
  const created = await herdrCli(["workspace", "create", "--label", label, "--no-focus"]);
  if (!created.ok) {
    ready = false;
    return;
  }
  const result = readResult(created.stdout);
  const ws = result.workspace;
  const root = result.root_pane;
  const wsId = typeof ws === "object" && ws !== null ? (ws as Record<string, unknown>) : {};
  const rootPane =
    typeof root === "object" && root !== null ? (root as Record<string, unknown>) : {};
  workspaceId = typeof wsId.workspace_id === "string" ? wsId.workspace_id : undefined;
  paneId = typeof rootPane.pane_id === "string" ? rootPane.pane_id : undefined;
  ready = paneId !== undefined;
}, 30_000);

afterAll(async () => {
  resetHerdrExecutor();
  // Close only the workspace WE created. Never the session, never the
  // server, never anything pre-existing.
  if (workspaceId !== undefined) await herdrCli(["workspace", "close", workspaceId]);
}, 20_000);

describe("herdr IO against a real server", () => {
  it("sendToPane reaches a plain shell pane via the pane-surface fallback", async () => {
    if (!ready || paneId === undefined) return;
    // No recognized agent in a fresh shell pane, so `agent prompt`
    // answers agent_not_found and sendToPane retries via `pane run`.
    await sendToPane(paneId, "echo mu-io-probe-42");
    let seen = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      seen = await capturePane(paneId, { lines: 50 });
      if (seen.includes("mu-io-probe-42")) break;
    }
    expect(seen).toContain("mu-io-probe-42");
  }, 20_000);

  it("capturePane returns plain text, not a JSON envelope", async () => {
    if (!ready || paneId === undefined) return;
    const visible = await capturePane(paneId, { lines: 0 });
    expect(typeof visible).toBe("string");
    expect(() => JSON.parse(visible)).toThrow();
  }, 20_000);
});
