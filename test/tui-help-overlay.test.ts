import { describe, expect, it } from "vitest";
import { Help } from "../src/cli/tui/help.js";

function renderToString(node: unknown): string {
  function walk(n: unknown): string {
    if (n === null || n === undefined) return "";
    if (typeof n === "string") return n;
    if (typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(walk).join("");
    if (typeof n === "object" && n !== null && "props" in n) {
      const element = n as { type?: unknown; props: { children?: unknown } };
      if (typeof element.type === "function") return walk(element.type(element.props));
      return walk(element.props.children);
    }
    return "";
  }
  return walk(node);
}

describe("TUI help overlay", () => {
  it("documents the dashboard keymap including omitted-from-bar keys", () => {
    const text = renderToString(Help());
    expect(text).toContain("keys · dashboard");
    expect(text).toContain("0-9");
    expect(text).toContain(
      "toggle Commits/Agents/Tracks/Ready/Log/Workspaces/In-progress/Blocked/Recent/Doctor cards",
    );
    expect(text).toContain("Shift 0-9");
    expect(text).toContain("open numbered popups");
    expect(text).toContain("g");
    expect(text).toContain("DAG popup");
    expect(text).toContain("t");
    expect(text).toContain("all-tasks popup");
    expect(text).toContain("Tab / Shift-Tab");
    expect(text).toContain("c");
    expect(text).toContain("clear footer");
    expect(text).toContain("0");
    expect(text).toContain("Commits card");
    expect(text).toContain("tick reset is not bound");
    expect(text).toContain("+/=");
    expect(text).toContain("tick faster");
    expect(text).toContain("-");
    expect(text).toContain("tick slower");
    expect(text).toContain("r/F5");
    expect(text).toContain("refresh now");
    expect(text).toContain("q/Q");
    expect(text).toContain("quit");
    expect(text).not.toContain("slot 0 stays reserved");
  });

  it("splits popup list, drill, and filter help panes", () => {
    const text = renderToString(Help());
    expect(text).toContain("keys · popup list");
    expect(text).toContain("move selection");
    expect(text).toContain("Ctrl-D/U");
    expect(text).toContain("PgDn/PgUp");
    expect(text).toContain("filter/search rows");
    expect(text).toContain("Shift 0-9");
    expect(text).toContain("back to dashboard");

    expect(text).toContain("keys · popup drill");
    expect(text).toContain("scroll one line");
    expect(text).toContain("top / bottom");
    expect(text).toContain("yank drill-specific command");
    expect(text).toContain("back one drill level");

    expect(text).toContain("keys · popup filter");
    expect(text).toContain("append printable characters to the filter");
    expect(text).toContain("Backspace");
    expect(text).toContain("edit query");
    expect(text).toContain("commit filter");
    expect(text).toContain("cancel filter");
  });

  it("documents DAG/all-tasks status toggles and all-tasks sort/search keys", () => {
    const text = renderToString(Help());
    expect(text).toContain("keys · DAG / all-tasks");
    expect(text).toContain("o/i/c/r/d");
    expect(text).toContain("OPEN / IN_PROGRESS / CLOSED / REJECTED / DEFERRED");
    expect(text).toContain("all-tasks sort cycle");
    expect(text).toContain("roi → recency → age → id");
    expect(text).toContain("all-tasks row search");
  });

  it("drops stale pseudo-rows", () => {
    const text = renderToString(Help());
    expect(text).not.toContain("v0.next");
    expect(text).not.toContain("(any letter)");
    expect(text).not.toContain("see popup footer");
  });
});
