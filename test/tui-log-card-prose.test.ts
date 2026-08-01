// v2-log-verb — the TUI Activity-log card renders through the SHARED
// formatter, not its own prose logic.
//
// Behaviour test over the CaptureStream seam (test/README.md): boot the
// card into a fake stdout and assert on what the user sees. The property
// that matters is that the card and `mu log` agree, because before this
// change the card had its own classifyEventVerb call and a payload
// fallback that printed raw JSON.

import { render } from "ink";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LogCard } from "../src/cli/tui/cards/log.js";
import { renderOpLine } from "../src/log-render.js";
import type { LogRow } from "../src/logs.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import {
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  waitForInkOutput,
} from "./_ink-render.js";

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) {
    try {
      u();
    } catch {}
  }
});

function capturedOp(seq: number, intent: string, key: string, payload: string): LogRow {
  return {
    seq,
    workstreamName: key,
    source: "worker-1",
    intent,
    group: `grp-${seq}`,
    op: "put",
    kind: intent.slice(0, intent.indexOf(".")),
    payload,
    createdAt: `2026-05-11T09:00:0${seq % 10}.000Z`,
  };
}

const EMPTY: WorkstreamSnapshot = {
  workstreamName: "demo",
  view: {
    agents: [],
    orphans: [],
    report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
  },
  tracks: [],
  ready: [],
  blocked: [],
  inProgress: [],
  recentClosed: [],
  allTasks: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
  recentCommits: [],
  commitsBackend: null,
  doctor: null,
};

async function renderCard(recent: LogRow[]): Promise<string> {
  const stdout = createInkCaptureStream({ columns: 120, rows: 24 });
  const stdin = createInkInputStream();
  const { unmount } = render(
    React.createElement(LogCard, { snapshot: { ...EMPTY, recent }, cols: 120 }),
    { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
  );
  unmounts.push(unmount);
  await waitForInkOutput(stdout);
  return latestRenderedFrame(stdout).join("\n");
}

describe("Activity-log card renders shared prose", () => {
  it("renders a normal session non-empty, with no raw JSON", async () => {
    const text = await renderCard([
      capturedOp(1, "workstream.init", "demo", '{"name":"demo"}'),
      capturedOp(2, "task.add", "demo/a", '{"local_id":"a","title":"Build auth","impact":80}'),
      capturedOp(3, "task.update", "demo/a", '{"impact":90,"updated_at":"2026-05-11T09:00:03Z"}'),
      capturedOp(4, "task.close", "demo/a", '{"status":"CLOSED"}'),
    ]);

    expect(text).toContain("Activity log");
    // Non-empty for a normal session — the card must not go blank now
    // that payloads are structured.
    expect(text).not.toContain("(no events yet)");
    expect(text).toContain("task add");
    expect(text).toContain("task close");
    // The whole point: no payload braces leak into the pane.
    expect(text).not.toContain("{");
    expect(text).not.toContain("updated_at");
  });

  it("agrees with the shared formatter (no card-local phrasing)", async () => {
    const row = capturedOp(7, "task.close", "demo/auth", '{"status":"CLOSED"}');
    const text = await renderCard([row]);
    // Every token the formatter produces must appear in the card. If the
    // card ever grows its own wording, this breaks.
    for (const token of renderOpLine(row).split(" ")) {
      expect(text, `card must show "${token}"`).toContain(token);
    }
  });

  it("shows operator prose (no intent) verbatim", async () => {
    const ledger: LogRow = {
      seq: 9,
      workstreamName: "demo",
      source: "user",
      intent: null,
      group: "grp-9",
      op: "put",
      kind: "pr-state",
      payload: "pr=1234 ci=red",
      createdAt: "2026-05-11T09:00:09.000Z",
    };
    const text = await renderCard([ledger]);
    expect(text).toContain("pr=1234 ci=red");
  });

  it("renders local agent ops without repeating the verb", async () => {
    const spawn: LogRow = {
      seq: 11,
      workstreamName: "demo",
      source: "system",
      intent: "agent.spawn",
      group: "grp-11",
      op: "put",
      kind: "agent",
      payload: "agent spawn worker-3 (cli=pi, pane=%5)",
      createdAt: "2026-05-11T09:00:01.000Z",
    };
    const text = await renderCard([spawn]);
    expect(text).toContain("agent spawn");
    expect(text).toContain("worker-3");
    const occurrences = text.split("agent spawn").length - 1;
    expect(occurrences).toBe(1);
  });
});
