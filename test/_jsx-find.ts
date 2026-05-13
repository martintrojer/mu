import { type ReactElement, isValidElement } from "react";

export function findElementsByTypeName(node: unknown, typeName: string): unknown[] {
  const found: unknown[] = [];

  function walk(n: unknown): void {
    if (n === null || n === undefined || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;

    const element = n as ReactElement<{ children?: unknown }>;
    const component = element.type;
    if (typeof component === "function") {
      if (component.name === typeName) found.push(element);
      walk(element.props.children);
      return;
    }

    walk(element.props.children);
  }

  walk(node);
  return found;
}

interface ListRowLikeProps {
  cells?: readonly string[];
  colors?: readonly { color?: string; bold?: boolean; dimColor?: boolean }[];
}

export function findListRowByCell(node: unknown, cell: string): ListRowLikeProps | undefined {
  for (const row of findElementsByTypeName(node, "ListRow")) {
    if (!isValidElement(row)) continue;
    const props = row.props as ListRowLikeProps;
    if (props.cells?.some((c) => c.trim() === cell)) return props;
  }
  return undefined;
}
