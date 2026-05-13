import { useEffect, useRef } from "react";
import { MOUSE_MODE_ENTER, MOUSE_MODE_EXIT } from "./escapes.js";

export const DOUBLE_CLICK_MS = 300;

export type MouseButton = 0 | 1 | 2 | number;

export interface MouseBaseEvent {
  x: number;
  y: number;
  button: MouseButton;
  ts: number;
}

export interface MousePressEvent extends MouseBaseEvent {
  kind: "press";
}

export interface MouseReleaseEvent extends MouseBaseEvent {
  kind: "release";
}

export interface MouseScrollEvent extends MouseBaseEvent {
  kind: "scroll";
  direction: "up" | "down";
}

export interface MouseDoubleClickEvent extends MouseBaseEvent {
  kind: "doubleclick";
}

export type ParsedMouseEvent = MousePressEvent | MouseReleaseEvent | MouseScrollEvent;
export type MouseEvent = ParsedMouseEvent | MouseDoubleClickEvent;

export type MouseSubscriber = (event: MouseEvent) => void;

type MouseReportSubscriber = (event: ParsedMouseEvent) => void;

const subscribers = new Set<MouseReportSubscriber>();
const SGR_MOUSE_PATTERN = "\\u001b\\[<(\\d+);(\\d+);(\\d+)([Mm])";
let stdinAttached = false;
let pending = "";

export function enableMouseMode(): void {
  process.stdout.write(MOUSE_MODE_ENTER);
}

export function disableMouseMode(): void {
  process.stdout.write(MOUSE_MODE_EXIT);
}

export function parseSgrMouseEvents(
  input: string,
  now: () => number = Date.now,
): ParsedMouseEvent[] {
  const events: ParsedMouseEvent[] = [];
  const re = new RegExp(SGR_MOUSE_PATTERN, "g");
  let match = re.exec(input);
  while (match !== null) {
    const codeText = match[1];
    const xText = match[2];
    const yText = match[3];
    const suffix = match[4];
    if (
      codeText === undefined ||
      xText === undefined ||
      yText === undefined ||
      suffix === undefined
    ) {
      match = re.exec(input);
      continue;
    }
    const code = Number.parseInt(codeText, 10);
    const x = Number.parseInt(xText, 10);
    const y = Number.parseInt(yText, 10);
    if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) {
      match = re.exec(input);
      continue;
    }

    const ts = now();
    if (suffix === "M" && (code === 64 || code === 65)) {
      events.push({
        kind: "scroll",
        direction: code === 64 ? "up" : "down",
        x,
        y,
        button: code,
        ts,
      });
      match = re.exec(input);
      continue;
    }

    const button = code & 3;
    if (suffix === "m") {
      events.push({ kind: "release", x, y, button, ts });
    } else {
      events.push({ kind: "press", x, y, button, ts });
    }
    match = re.exec(input);
  }
  return events;
}

export interface DoubleClickDetectorOptions {
  windowMs?: number;
}

export interface DoubleClickDetector {
  push: (event: ParsedMouseEvent) => MouseEvent[];
}

export function createDoubleClickDetector(
  opts: DoubleClickDetectorOptions = {},
): DoubleClickDetector {
  const windowMs = opts.windowMs ?? DOUBLE_CLICK_MS;
  let lastPress: MousePressEvent | null = null;
  return {
    push(event) {
      if (event.kind !== "press") return [event];
      const previous = lastPress;
      lastPress = event;
      if (
        previous !== null &&
        event.ts - previous.ts <= windowMs &&
        event.x === previous.x &&
        event.y === previous.y &&
        event.button === previous.button
      ) {
        return [
          event,
          { kind: "doubleclick", x: event.x, y: event.y, button: event.button, ts: event.ts },
        ];
      }
      return [event];
    },
  };
}

export function useMouse(
  onEvent: MouseSubscriber,
  opts: { isActive?: boolean; doubleClickMs?: number } = {},
): void {
  const callback = useRef(onEvent);
  callback.current = onEvent;
  const detector = useRef(createDoubleClickDetector({ windowMs: opts.doubleClickMs }));

  useEffect(() => {
    detector.current = createDoubleClickDetector({ windowMs: opts.doubleClickMs });
  }, [opts.doubleClickMs]);

  useEffect(() => {
    if (opts.isActive === false) return undefined;
    return subscribeToMouseReports((event) => {
      for (const emitted of detector.current.push(event)) {
        callback.current(emitted);
      }
    });
  }, [opts.isActive]);
}

export function mouseEventToNavAction(
  event: MouseEvent,
): { kind: "moveUp" } | { kind: "moveDown" } | null {
  if (event.kind !== "scroll") return null;
  return event.direction === "up" ? { kind: "moveUp" } : { kind: "moveDown" };
}

function subscribeToMouseReports(fn: MouseReportSubscriber): () => void {
  subscribers.add(fn);
  attachStdin();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) detachStdin();
  };
}

function attachStdin(): void {
  if (stdinAttached) return;
  process.stdin.on("data", onStdinData);
  stdinAttached = true;
}

function detachStdin(): void {
  if (!stdinAttached) return;
  process.stdin.off("data", onStdinData);
  stdinAttached = false;
  pending = "";
}

function onStdinData(chunk: Buffer | string): void {
  pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const parsed: ParsedMouseEvent[] = [];
  const re = new RegExp(SGR_MOUSE_PATTERN, "g");
  let lastEnd = 0;
  let match = re.exec(pending);
  while (match !== null) {
    const report = match[0];
    lastEnd = re.lastIndex;
    parsed.push(...parseSgrMouseEvents(report));
    match = re.exec(pending);
  }
  if (lastEnd > 0) {
    pending = pending.slice(lastEnd);
  } else {
    const lastEscape = pending.lastIndexOf("\x1b[<");
    pending = lastEscape >= 0 ? pending.slice(lastEscape) : "";
  }
  for (const event of parsed) {
    for (const subscriber of subscribers) subscriber(event);
  }
}
