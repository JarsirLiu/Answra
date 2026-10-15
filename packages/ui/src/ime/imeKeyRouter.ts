export type ImeKeyRoute =
  | { type: "toggle-mode" }
  | { type: "consumed" }
  | { type: "editor"; text: string }
  | { type: "engine"; key: string; release: boolean }
  | { type: "browser" }
  | { type: "ignored" };

export interface ImeKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

export function resolveImeKeyRoute(
  event: ImeKeyEvent,
  state: { inputMode: "ascii" | "chinese"; composing: boolean },
  release = false,
): ImeKeyRoute {
  const key = normalizeKey(event.key, event.code);
  if (key === "Shift") {
    if (release) return { type: "consumed" };
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return { type: "browser" };
    return { type: "toggle-mode" };
  }

  if (release) return { type: "ignored" };
  if (key === "Backspace" && !state.composing) return { type: "browser" };
  if ((event.ctrlKey || event.altKey || event.metaKey) && !state.composing)
    return { type: "browser" };
  if (
    state.inputMode === "ascii" &&
    key?.length === 1 &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  )
    return { type: "browser" };
  if (
    state.inputMode === "chinese" &&
    !state.composing &&
    key &&
    /^[0-9]$/.test(key) &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  )
    return { type: "editor", text: key };
  if (!key || (key.length !== 1 && !state.composing)) return { type: "ignored" };
  return { type: "engine", key, release: false };
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
