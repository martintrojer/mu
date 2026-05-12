// Tests for src/cli/tui/list-row.tsx — the centralised non-selected
// row primitive. See feat_centralize_list_row_render (workstream
// `tui-impl`) and the sibling test/tui-cursor-row.test.ts for the
// selected-branch primitive.
//
// We use React element introspection (no ink renderer needed) — same
// trick test/tui-cursor-row.test.ts uses for CursorRow.

import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { COL_GUTTER } from "../src/cli/tui/columns.js";
import { ListRow } from "../src/cli/tui/list-row.js";
import { CursorRow } from "../src/cli/tui/popups/cursor-row.js";

describe("ListRow component", () => {
  it("pins width on the outer Box", () => {
    const el = ListRow({ cells: ["a", "bb", "c"], contentWidth: 30 });
    expect(isValidElement(el)).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    expect(box.props.width).toBe(30);
  });

  it('wraps the children in <Text wrap="truncate"> on the outer Text', () => {
    const el = ListRow({ cells: ["a", "b"], contentWidth: 20 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const text = box.props.children;
    expect(isValidElement(text)).toBe(true);
    expect(text.props.wrap).toBe("truncate");
    expect(text.props.inverse).toBeUndefined();
  });

  it("interleaves cells with the canonical COL_GUTTER 2-space literal", () => {
    const el = ListRow({ cells: ["a", "bb", "c"], contentWidth: 20 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const children = box.props.children.props.children as React.ReactNode[];
    // 3 cells + 2 gutters = 5 children, alternating cell/gutter/cell.
    expect(children.length).toBe(5);
    const gutter = " ".repeat(COL_GUTTER);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const cell = (n: any) => n.props.children as string;
    expect(cell(children[0])).toBe("a");
    expect(cell(children[1])).toBe(gutter);
    expect(cell(children[2])).toBe("bb");
    expect(cell(children[3])).toBe(gutter);
    expect(cell(children[4])).toBe("c");
  });

  it("applies per-cell colour spec to the matching <Text>", () => {
    const el = ListRow({
      cells: ["a", "b", "c"],
      contentWidth: 20,
      colors: [{ color: "yellow" }, { bold: true }, { dimColor: true }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const children = box.props.children.props.children as React.ReactNode[];
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const cellNode = (i: number) => children[i] as any;
    expect(cellNode(0).props.color).toBe("yellow");
    expect(cellNode(0).props.bold).toBeUndefined();
    expect(cellNode(0).props.dimColor).toBeUndefined();
    expect(cellNode(2).props.bold).toBe(true);
    expect(cellNode(2).props.color).toBeUndefined();
    expect(cellNode(4).props.dimColor).toBe(true);
    expect(cellNode(4).props.color).toBeUndefined();
  });

  it("renders missing/undefined colour entries as plain <Text>", () => {
    const el = ListRow({
      cells: ["a", "b", "c"],
      contentWidth: 20,
      colors: [{ color: "red" }, undefined, { dimColor: true }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const children = box.props.children.props.children as React.ReactNode[];
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const middle = children[2] as any;
    expect(middle.props.color).toBeUndefined();
    expect(middle.props.bold).toBeUndefined();
    expect(middle.props.dimColor).toBeUndefined();
    expect(middle.props.children).toBe("b");
  });

  it("falls back to plain <Text> when colors is omitted entirely", () => {
    const el = ListRow({ cells: ["a"], contentWidth: 5 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const children = box.props.children.props.children as React.ReactNode[];
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const only = children[0] as any;
    expect(only.props.color).toBeUndefined();
    expect(only.props.bold).toBeUndefined();
    expect(only.props.dimColor).toBeUndefined();
    expect(only.props.children).toBe("a");
  });

  it("delegates to CursorRow when selected=true (matches CursorRow's contract)", () => {
    const el = ListRow({ cells: ["a", "b"], contentWidth: 10, selected: true });
    // selected=true returns the CursorRow JSX element directly — its
    // type IS CursorRow and its props mirror CursorRowProps. The
    // CursorRow tests (test/tui-cursor-row.test.ts) cover what the
    // rendered tree looks like; here we only need to confirm the
    // delegation happens with the right props.
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const node = el as any;
    expect(node.type).toBe(CursorRow);
    expect(node.props.contentWidth).toBe(10);
    expect(node.props.cells).toEqual(["a", "b"]);
    // colors / selected props are not forwarded — CursorRow doesn't
    // accept them. Verifies the contract narrowing.
    expect(node.props.colors).toBeUndefined();
    expect(node.props.selected).toBeUndefined();
  });

  it("selected=true drops per-cell colours from the delegated CursorRow", () => {
    const el = ListRow({
      cells: ["a", "b"],
      contentWidth: 10,
      colors: [{ color: "yellow" }, { bold: true }],
      selected: true,
    });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const node = el as any;
    expect(node.type).toBe(CursorRow);
    // CursorRow has no `colors` concept; passing them at the ListRow
    // boundary simply means they're discarded for the highlight line.
    expect(node.props.colors).toBeUndefined();
  });

  it("handles a single cell without producing a leading gutter", () => {
    const el = ListRow({ cells: ["only"], contentWidth: 20 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const children = box.props.children.props.children as React.ReactNode[];
    expect(children.length).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const only = children[0] as any;
    expect(only.props.children).toBe("only");
  });

  it("handles zero cells gracefully (empty children array)", () => {
    const el = ListRow({ cells: [], contentWidth: 20 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const children = box.props.children.props.children as React.ReactNode[];
    expect(children.length).toBe(0);
  });
});
