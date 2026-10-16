import type { ImeInputMode } from "@answra/shared";

export type ImeKeyRoute =
  | { type: "consumed" }
  | { type: "editor"; command: ImeEditorCommand }
  | { type: "engine"; key: string; release: boolean }
  | { type: "browser" }
  | { type: "ignored" };

export type ImeEditorCommand =
  | { type: "deleteBackward" }
  | { type: "deleteForward" }
  | {
      type: "moveCaret";
      direction: "left" | "right" | "up" | "down" | "pageUp" | "pageDown";
      extend: boolean;
    };

export interface ImeKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/**
 * The engine facts a key route depends on. Callers must read them from the single
 * session snapshot (`selectImeEngineState`) instead of assembling the fields themselves.
 */
export interface ImeEngineState {
  inputMode: ImeInputMode;
  composing: boolean;
}

export function resolveImeKeyRoute(
  event: ImeKeyEvent,
  engine: ImeEngineState,
  release = false,
): ImeKeyRoute {
  const key = normalizeKey(event.key, event.code);
  if (key === "Shift") {
    if (event.ctrlKey || event.altKey || event.metaKey) return { type: "browser" };
    return { type: "engine", key, release };
  }

  if (release) return { type: "ignored" };
  if (event.ctrlKey || event.altKey || event.metaKey) return { type: "browser" };
  if (key?.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey)
    return { type: "engine", key, release: false };
  if (key === "Backspace" || key === "Delete") {
    return engine.composing
      ? { type: "engine", key, release: false }
      : {
          type: "editor",
          command: { type: key === "Backspace" ? "deleteBackward" : "deleteForward" },
        };
  }
  if (!key) return { type: "ignored" };
  const direction = navigationDirection(key);
  if (direction) {
    return engine.composing
      ? { type: "engine", key, release: false }
      : { type: "editor", command: { type: "moveCaret", direction, extend: event.shiftKey } };
  }
  if (key.length !== 1 && !engine.composing) return { type: "ignored" };
  return { type: "engine", key, release: false };
}

function navigationDirection(
  key: string | undefined,
): "left" | "right" | "up" | "down" | "pageUp" | "pageDown" | undefined {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "PageUp":
      return "pageUp";
    case "PageDown":
      return "pageDown";
    default:
      return undefined;
  }
}

/** Windows marks keys consumed by its IME as "Process"; recover the physical key. */
function normalizeKey(key: string, code: string): string | undefined {
  if (key === "Shift" && (code === "ShiftLeft" || code === "ShiftRight")) return "Shift";
  if (key !== "Process") return key;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  return undefined;
}
