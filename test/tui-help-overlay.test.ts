import { describe, expect, it } from "vitest";
import {
  HelpView,
  applyHelpScroll,
  flattenHelpRows,
  helpPositionLabel,
  helpViewport,
} from "../src/cli/tui/help.js";
import { HELP_PANES } from "../src/cli/tui/keymap-spec.js";

type ElementLike = { type?: unknown; props: Record<string, unknown> };

const HELP_ROWS = flattenHelpRows();

function isElementLike(node: unknown): node is ElementLike {
  return (
    typeof node === "object" &&
    node !== null &&
    "props" in node &&
    typeof (node as { props?: unknown }).props === "object" &&
    (node as { props?: unknown }).props !== null
  );
}

function childrenArray(children: unknown): unknown[] {
  if (children === null || children === undefined || typeof children === "boolean") return [];
  return Array.isArray(children) ? children.flatMap(childrenArray) : [children];
}

function visitElements(node: unknown, visit: (element: ElementLike) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) visitElements(child, visit);
    return;
  }
  if (!isElementLike(node)) return;
  visit(node);
  visitElements(node.props.children, visit);
}

function renderToString(node: unknown): string {
  function walk(n: unknown): string {
    if (n === null || n === undefined) return "";
    if (typeof n === "string") return n;
    if (typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(walk).join("");
    if (isElementLike(n)) {
      return [
        walk(n.props.title),
        walk(n.props.subtitle),
        walk(n.props.bottomLabel),
        walk(n.props.keys),
        walk(n.props.effect),
        walk(n.props.children),
      ].join("");
    }
    return "";
  }
  return walk(node);
}

function visibleText(rows: number, scrollTop = 0): string {
  return renderToString(HelpView({ rows, scrollTop }));
}

describe("TUI help overlay", () => {
  it("renders only the fixed viewport on low-row panes", () => {
    const viewport = helpViewport(15);
    expect(viewport).toBe(12);
    expect(HELP_ROWS).toHaveLength(56);

    const text = visibleText(15);
    expect(text).toContain("keys · 1-12/56");
    expect(text).toContain("keys · dashboard");
    expect(text).toContain("toggle this overlay");
    expect(text).not.toContain("keys · popup list");
    expect(text).not.toContain("mouse");
  });

  it("scrolls with popup navigation semantics and clamps at the bottom", () => {
    expect(applyHelpScroll(0, { kind: "moveDown" }, 15, HELP_ROWS.length)).toBe(1);
    expect(applyHelpScroll(1, { kind: "pageDown", half: true }, 15, HELP_ROWS.length)).toBe(7);
    expect(applyHelpScroll(7, { kind: "jumpBottom" }, 15, HELP_ROWS.length)).toBe(44);
    expect(applyHelpScroll(44, { kind: "moveDown" }, 15, HELP_ROWS.length)).toBe(44);
    expect(applyHelpScroll(44, { kind: "jumpTop" }, 15, HELP_ROWS.length)).toBe(0);
    expect(applyHelpScroll(3, { kind: "noop" }, 15, HELP_ROWS.length)).toBe(3);
  });

  it("computes the inset position indicator from the visible range", () => {
    expect(helpPositionLabel(0, 12, HELP_ROWS.length)).toBe("1-12/56");
    expect(helpPositionLabel(11, 12, HELP_ROWS.length)).toBe("12-23/56");
    expect(helpPositionLabel(44, 12, HELP_ROWS.length)).toBe("45-56/56");
    expect(visibleText(15, 11)).toContain("keys · 12-23/56");
  });

  it("hides the position indicator and renders all rows when the pane is tall enough", () => {
    const text = visibleText(200);
    expect(helpPositionLabel(0, helpViewport(200), HELP_ROWS.length)).toBeUndefined();
    expect(text).not.toContain("1-12/56");
    expect(text).toContain("keys · dashboard");
    expect(text).toContain("keys · popup list");
    expect(text).toContain("keys · popup drill");
    expect(text).toContain("keys · popup filter");
    expect(text).toContain("keys · DAG / all-tasks");
    expect(text).toContain("mouse");
    expect(text).toContain("no mouse back; use Esc/q");
  });

  it("renders as one rounded outer box instead of side-by-side bordered panes", () => {
    const root = HelpView({ rows: 200 });
    expect(isElementLike(root)).toBe(true);
    if (!isElementLike(root)) throw new Error("Help() should return a JSX element");

    expect(root.props.title).toBe("keys");
    expect(root.props.borderColor).toBe("cyan");
    expect(root.props.titleColor).toBe("cyan");
    expect(root.props.width).toBe(process.stdout.columns ?? 80);

    const sideBySidePaneBoxes = childrenArray(root.props.children).filter(
      (child) => isElementLike(child) && child.props.borderStyle === "round",
    );
    expect(sideBySidePaneBoxes).toHaveLength(0);
  });

  it("renders every section header in bold cyan", () => {
    const root = HelpView({ rows: 200 });
    const elements: ElementLike[] = [];
    visitElements(root, (element) => elements.push(element));

    for (const pane of HELP_PANES) {
      const matchingHeaders = elements.filter(
        (element) =>
          element.props.children === pane.title &&
          element.props.bold === true &&
          element.props.color === "cyan",
      );
      expect(matchingHeaders, pane.title).toHaveLength(1);
    }
  });

  it("renders one blank-line separator between each help section", () => {
    const root = HelpView({ rows: 200 });
    expect(isElementLike(root)).toBe(true);
    if (!isElementLike(root)) throw new Error("Help() should return a JSX element");

    expect(flattenHelpRows().filter((row) => row.kind === "separator")).toHaveLength(
      HELP_PANES.length - 1,
    );

    const blankTextNodes: ElementLike[] = [];
    visitElements(root, (element) => {
      if (element.props.children === " ") blankTextNodes.push(element);
    });
    expect(blankTextNodes).toHaveLength(HELP_PANES.length - 1);
  });

  it("documents the dashboard keymap including omitted-from-bar keys", () => {
    const text = visibleText(200);
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
    const text = visibleText(200);
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
    const text = visibleText(200);
    expect(text).toContain("keys · DAG / all-tasks");
    expect(text).toContain("o/i/c/r/d");
    expect(text).toContain("OPEN / IN_PROGRESS / CLOSED / REJECTED / DEFERRED");
    expect(text).toContain("all-tasks sort cycle");
    expect(text).toContain("roi → recency → age → id");
    expect(text).toContain("all-tasks row search");
  });

  it("drops stale pseudo-rows", () => {
    const text = visibleText(200);
    expect(text).not.toContain("v0.next");
    expect(text).not.toContain("(any letter)");
    expect(text).not.toContain("see popup footer");
  });

  it("documents mouse bindings and the no-mouse-back rule", () => {
    // Mouse bindings live in the canonical keymap spec; Help() iterates
    // HELP_PANES from there so a single source-of-truth feeds both the
    // overlay and the orphan-hint regression test.
    const text = visibleText(200);
    expect(text).toContain("mouse");
    expect(text).toContain("double-click card");
    expect(text).toContain("drill into popup");
    expect(text).toContain("double-click row");
    expect(text).toContain("drill into row detail");
    expect(text).toContain("scroll wheel");
    expect(text).toContain("no mouse back; use Esc/q");
  });
});
