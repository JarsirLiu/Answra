/** 终端 SGR/X10 鼠标滚轮解析：把滚轮事件从 stdin 流中剥离，其余输入原样交给 Ink。 */
import { PassThrough } from "node:stream";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";
const MAX_MOUSE_SEQUENCE_LENGTH = 32;
const SGR_PREFIX = "\x1b[<";
const X10_PREFIX = "\x1b[M";

export type WheelDirection = -1 | 1;

export interface WheelSource {
  subscribe(listener: (direction: WheelDirection) => void): () => void;
}

export interface WheelInput {
  readonly stdin: NodeJS.ReadableStream;
  readonly source: WheelSource;
  dispose(): void;
}

type TtyInput = Omit<NodeJS.ReadableStream, "setEncoding"> & {
  isTTY?: boolean;
  ref?: () => void;
  setEncoding?: (encoding: BufferEncoding) => unknown;
  setRawMode?: (mode: boolean) => void;
  unref?: () => void;
};

export interface WheelParseResult {
  readonly text: string;
  readonly pending: string;
  readonly directions: readonly WheelDirection[];
}

export function parseWheelInput(chunk: string, pending = ""): WheelParseResult {
  const data = pending + chunk;
  const directions: WheelDirection[] = [];
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
        return { text, pending: data.slice(start), directions };
      }
      const direction = wheelDirectionFromButton(data.charCodeAt(start + 3) - 32);
      if (direction !== undefined) directions.push(direction);
      index = start + 6;
      continue;
    }

    const match = /^(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(start + SGR_PREFIX.length));
    if (match) {
      const direction = wheelDirectionFromButton(Number(match[1]));
      if (direction !== undefined) directions.push(direction);
      index = start + SGR_PREFIX.length + match[0].length;
      continue;
    }

    if (data.length - start < MAX_MOUSE_SEQUENCE_LENGTH) {
      return { text, pending: data.slice(start), directions };
    }
    text += data[start];
    index = start + 1;
  }

  return { text, pending: "", directions };
}

export function createWheelInput(
  input: TtyInput,
  output: NodeJS.WritableStream,
): WheelInput | undefined {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") return undefined;

  const proxy = Object.assign(new PassThrough(), {
    isTTY: true,
    ref: () => input.ref?.(),
    setRawMode: (mode: boolean) => input.setRawMode?.(mode),
    unref: () => input.unref?.(),
  });
  proxy.setEncoding("utf8");

  const listeners = new Set<(direction: WheelDirection) => void>();
  const source: WheelSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  let pending = "";
  let disposed = false;

  const forward = (chunk: string | Buffer): void => {
    const parsed = parseWheelInput(chunk.toString(), pending);
    pending = parsed.pending;
    for (const direction of parsed.directions) {
      for (const listener of listeners) listener(direction);
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
