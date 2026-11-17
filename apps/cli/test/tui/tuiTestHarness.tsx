import type { PointerEvent } from "../../src/tui/interaction/pointerInput";
import type { TuiPanelHandlers } from "../../src/tui/panels/panel";

type ProbeListener = (...args: unknown[]) => void;

class ProbeEmitter {
  private readonly listeners = new Map<string, Set<ProbeListener>>();

  on(event: string, listener: ProbeListener): this {
    const listeners = this.listeners.get(event) ?? new Set<ProbeListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  addListener = this.on;

  once(event: string, listener: ProbeListener): this {
    const wrapper: ProbeListener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: ProbeListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener = this.off;

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event: string, ...args: unknown[]): boolean {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    return true;
  }
}

export const PANEL_HANDLERS: TuiPanelHandlers = {
  loadConfig: async () => ({ baseUrl: "", chatModel: "", apiKey: "" }),
  saveConfig: async () => {},
  loadModels: async () => ({ current: "", models: [] }),
  selectModel: async () => {},
  loadSessions: async () => ({ current: "", sessions: [] }),
  resumeSession: async () => {},
  close: () => {},
};

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class CursorProbeStdout extends ProbeEmitter {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  readonly chunks: string[] = [];
  write = (data: string, encodingOrCallback?: unknown, callback?: () => void) => {
    this.chunks.push(String(data));
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    else callback?.();
    return true;
  };
}

export class CursorProbeStdin extends ProbeEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const data = this.data;
    this.data = null;
    return data;
  };
}

const ESC = String.fromCharCode(27);

/** 取最后一次 cursorTo + show 序列的列号，验证真实终端光标被停到输入框。 */
export function lastParkedCursorColumn(raw: string): number | undefined {
  const segments = raw.split(`${ESC}[?25h`);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index] ?? "";
    const start = segment.lastIndexOf(`${ESC}[`);
    if (start === -1) continue;
    const token = segment.slice(start + ESC.length + 1);
    if (!token.endsWith("G")) continue;
    const column = Number(token.slice(0, -1));
    if (Number.isInteger(column)) return column - 1;
  }
  return undefined;
}

export function createPointerSource() {
  const listeners = new Set<(event: PointerEvent) => void>();
  return {
    subscribe(listener: (event: PointerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PointerEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

export function wheelEvent(direction: -1 | 1): PointerEvent {
  return { kind: "wheel", direction, point: { row: 0, col: 0 } };
}
