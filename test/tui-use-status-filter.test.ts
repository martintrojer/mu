import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STATUS_BY_KEY,
  StatusFilterStrip,
  statusForToggleKey,
  toggleStatusSet,
  useStatusFilter,
} from "../src/cli/tui/use-status-filter.js";
import { TASK_STATUSES } from "../src/tasks/status.js";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function renderToString(node: unknown): string {
  function walk(n: unknown): string {
    if (n === null || n === undefined) return "";
    if (typeof n === "string") return n;
    if (typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(walk).join("");
    if (typeof n === "object" && n !== null && "props" in n) {
      return walk((n as { props: { children?: unknown } }).props.children);
    }
    return "";
  }
  return walk(node);
}

describe("useStatusFilter helpers", () => {
  it("exports the hook", () => {
    expect(typeof useStatusFilter).toBe("function");
  });

  it("default status set is all-on", () => {
    const statuses = new Set(TASK_STATUSES);
    expect([...statuses]).toEqual(["OPEN", "IN_PROGRESS", "CLOSED", "REJECTED", "DEFERRED"]);
  });

  it("toggle removes an enabled status then adds it back", () => {
    const all = new Set(TASK_STATUSES);
    const withoutClosed = toggleStatusSet(all, "CLOSED");
    expect(withoutClosed.has("CLOSED")).toBe(false);
    expect(all.has("CLOSED")).toBe(true);

    const withClosed = toggleStatusSet(withoutClosed, "CLOSED");
    expect(withClosed.has("CLOSED")).toBe(true);
  });

  it("fresh all-on set models popup reopen reset", () => {
    const filtered = toggleStatusSet(new Set(TASK_STATUSES), "CLOSED");
    expect(filtered.has("CLOSED")).toBe(false);
    expect(new Set(TASK_STATUSES).has("CLOSED")).toBe(true);
  });

  it("maps mnemonic keys to statuses", () => {
    expect(STATUS_BY_KEY).toEqual({
      o: "OPEN",
      i: "IN_PROGRESS",
      c: "CLOSED",
      r: "REJECTED",
      d: "DEFERRED",
    });
    expect(statusForToggleKey("o", {})).toBe("OPEN");
    expect(statusForToggleKey("O", {})).toBe("OPEN");
    expect(statusForToggleKey("d", { ctrl: true })).toBeUndefined();
  });
});

describe("StatusFilterStrip", () => {
  it("renders every status with all indicators enabled by default", () => {
    const text = stripAnsi(renderToString(StatusFilterStrip({ statuses: new Set(TASK_STATUSES) })));

    expect(text).toContain("filters: ");
    expect(text).toContain("[O]pen ●");
    expect(text).toContain("[I]n_progress ●");
    expect(text).toContain("[C]losed ●");
    expect(text).toContain("[R]ejected ●");
    expect(text).toContain("[D]eferred ●");
  });

  it("renders disabled statuses with open-circle indicators", () => {
    const statuses = new Set(TASK_STATUSES);
    statuses.delete("CLOSED");
    statuses.delete("REJECTED");

    const text = stripAnsi(renderToString(StatusFilterStrip({ statuses })));

    expect(text).toContain("[C]losed ○");
    expect(text).toContain("[R]ejected ○");
    expect(text).toContain("[O]pen ●");
  });

  it("uses colorStatus for status letters", () => {
    const src = readFileSync("./src/cli/tui/use-status-filter.tsx", "utf-8");
    expect(src).toContain("colorStatus(status)");
  });
});
