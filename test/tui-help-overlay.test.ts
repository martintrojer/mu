import { describe, expect, it } from "vitest";
import { Help } from "../src/cli/tui/help.js";
import { HELP_PANES } from "../src/cli/tui/keymap-spec.js";

type ElementLike = { type?: unknown; props: Record<string, unknown> };

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
      if (typeof n.type === "function") {
        const component = n.type as (props: Record<string, unknown>) => unknown;
        return walk(component(n.props));
      }
      return walk(n.props.children);
    }
    return "";
  }
  return walk(node);
}

describe("TUI help overlay", () => {
  it("renders as one rounded outer box instead of side-by-side bordered panes", () => {
    const root = Help();
    expect(isElementLike(root)).toBe(true);
    if (!isElementLike(root)) throw new Error("Help() should return a JSX element");

    expect(root.props.borderStyle).toBe("round");
    expect(root.props.borderColor).toBe("cyan");
    expect(root.props.paddingX).toBe(1);
    expect(root.props.flexDirection).toBe("column");
    expect(root.props.gap).toBeUndefined();

    const roundBoxes: ElementLike[] = [];
    visitElements(root, (element) => {
      if (element.props.borderStyle === "round") roundBoxes.push(element);
    });
    expect(roundBoxes).toHaveLength(1);

    const sideBySidePaneBoxes = childrenArray(root.props.children).filter(
      (child) => isElementLike(child) && child.props.borderStyle === "round",
    );
    expect(sideBySidePaneBoxes).toHaveLength(0);
  });

  it("renders every section header in bold cyan", () => {
    const root = Help();
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
    const root = Help();
    expect(isElementLike(root)).toBe(true);
    if (!isElementLike(root)) throw new Error("Help() should return a JSX element");

    const sections = childrenArray(root.props.children).filter(isElementLike);
    expect(sections).toHaveLength(HELP_PANES.length);

    for (const [idx, section] of sections.entries()) {
      expect(section.props.flexDirection).toBe("column");
      const sectionChildren = childrenArray(section.props.children);
      const firstChild = sectionChildren[0];
      if (idx === 0) {
        expect(isElementLike(firstChild) && firstChild.props.children === " ").toBe(false);
      } else {
        expect(isElementLike(firstChild)).toBe(true);
        if (!isElementLike(firstChild))
          throw new Error("section separator should be a JSX element");
        expect(firstChild.props.children).toBe(" ");
      }
    }

    const blankTextNodes: ElementLike[] = [];
    visitElements(root, (element) => {
      if (element.props.children === " ") blankTextNodes.push(element);
    });
    expect(blankTextNodes).toHaveLength(HELP_PANES.length - 1);
  });

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

  it("documents mouse bindings and the no-mouse-back rule", () => {
    // Mouse bindings live in the canonical keymap spec; Help() iterates
    // HELP_PANES from there so a single source-of-truth feeds both the
    // overlay and the orphan-hint regression test.
    const text = renderToString(Help());
    expect(text).toContain("mouse");
    expect(text).toContain("double-click card");
    expect(text).toContain("drill into popup");
    expect(text).toContain("double-click row");
    expect(text).toContain("drill into row detail");
    expect(text).toContain("scroll wheel");
    expect(text).toContain("no mouse back; use Esc/q");
  });
});
