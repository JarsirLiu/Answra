/** 终端指针输入：解析 SGR/X10 滚轮与左键按下/拖动/释放，其余字节原样交给 Ink。 */
import { PassThrough } from "node:stream";
import type { SelectionPoint } from "./selection";

const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l";
const MAX_MOUSE_SEQUENCE_LENGTH = 32;
const SGR_PREFIX = "\x1b[<";
const X10_PREFIX = "\x1b[M";

export type WheelDirection = -1 | 1;

export type PointerEvent =
  | { readonly kind: "wheel"; readonly direction: WheelDirection; readonly point: SelectionPoint }
  | { readonly kind: "press"; readonly point: SelectionPoint }
  | { readonly kind: "drag"; readonly point: SelectionPoint }
  | { readonly kind: "release"; readonly point: SelectionPoint };

export interface PointerSource {
  subscribe(listener: (event: PointerEvent) => void): () => void;
}

export interface PointerInput {
  readonly stdin: NodeJS.ReadableStream;
  readonly source: PointerSource;
  dispose(): void;
}

type TtyInput = Omit<NodeJS.ReadableStream, "setEncoding"> & {
  isTTY?: boolean;
  ref?: () => void;
  setEncoding?: (encoding: BufferEncoding) => unknown;
  setRawMode?: (mode: boolean) => unknown;
  unref?: () => void;
};

export interface PointerParseResult {
  readonly text: string;
  readonly pending: string;
  readonly events: readonly PointerEvent[];
}

export function parsePointerInput(chunk: string, pending = ""): PointerParseResult {
  const data = pending + chunk;
  const events: PointerEvent[] = [];
  let text = "";
  let index = 0;

  while (index < data.length) {
    const sgrIndex = data.indexOf(SGR_PREFIX, index);
    const x10Index = data.indexOf(X10_PREFIX, index);
    const start = firstNonNegative(sgrIndex, x10Index);
    if (start === -1) {
      text += data.slice(index);
      index = data.length;
      continue;
    }

    text += data.slice(index, start);
    if (start === x10Index) {
      if (data.length - start < 6) {
        return { text, pending: data.slice(start), events };
      }
      const direction = wheelDirectionFromButton(data.charCodeAt(start + 3) - 32);
      if (direction !== undefined) {
        events.push({ kind: "wheel", direction, point: { row: 0, col: 0 } });
      }
      index = start + 6;
      continue;
    }

    const match = /^(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(start + SGR_PREFIX.length));
    if (match) {
      const event = pointerEventFromSgr(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === "m" ? "m" : "M",
      );
      if (event !== undefined) events.push(event);
      index = start + SGR_PREFIX.length + match[0].length;
      continue;
    }

    if (data.length - start < MAX_MOUSE_SEQUENCE_LENGTH) {
      return { text, pending: data.slice(start), events };
    }
    text += data.charAt(start);
    index = start + 1;
  }

  return { text, pending: "", events };
}

export function createPointerInput(
  input: TtyInput,
  output: NodeJS.WritableStream,
): PointerInput | undefined {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") return undefined;

  const proxy = Object.assign(new PassThrough(), {
    isTTY: true,
    ref: () => input.ref?.(),
    setRawMode: (mode: boolean) => input.setRawMode?.(mode),
    unref: () => input.unref?.(),
  });
  proxy.setEncoding("utf8");

  const listeners = new Set<(event: PointerEvent) => void>();
  const source: PointerSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  let pending = "";
  let disposed = false;

  const forward = (chunk: string | Buffer): void => {
    const parsed = parsePointerInput(chunk.toString(), pending);
    pending = parsed.pending;
    for (const event of parsed.events) {
      for (const listener of listeners) listener(event);
    }
    if (parsed.text.length > 0) proxy.write(parsed.text);
  };

  input.setEncoding?.("utf8");
  input.on("data", forward);
  output.write(ENABLE_MOUSE);

  return {
    stdin: proxy,
    source,
    dispose() {
      if (disposed) return;
      disposed = true;
      input.removeListener("data", forward);
      output.write(DISABLE_MOUSE);
      proxy.end();
      listeners.clear();
    },
  };
}

function pointerEventFromSgr(
  button: number,
  x: number,
  y: number,
  terminator: string,
): PointerEvent | undefined {
  const wheel = wheelDirectionFromButton(button);
  if (wheel !== undefined) {
    return { kind: "wheel", direction: wheel, point: pointAt(x, y) };
  }
  if ((button & 0x40) !== 0) return undefined;
  const modifiers = button & 0x1c;
  if (modifiers !== 0) return undefined;
  if ((button & 0x03) !== 0) return undefined;
  const motion = (button & 0x20) !== 0;
  const point = pointAt(x, y);
  if (terminator === "m") return { kind: "release", point };
  return motion ? { kind: "drag", point } : { kind: "press", point };
}

function pointAt(x: number, y: number): SelectionPoint {
  return { row: Math.max(0, y - 1), col: Math.max(0, x - 1) };
}

function wheelDirectionFromButton(button: number): WheelDirection | undefined {
  if ((button & 0x40) === 0 || (button & 0x20) !== 0) return undefined;
  const low = button & 0x03;
  if (low === 0) return -1;
  if (low === 1) return 1;
  return undefined;
}

function firstNonNegative(left: number, right: number): number {
  if (left === -1) return right;
  if (right === -1) return left;
  return Math.min(left, right);
}
