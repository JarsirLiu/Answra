import type { ImeKeyRequest } from "@answra/shared";

export function rimeKeyCode(request: Pick<ImeKeyRequest, "key" | "code">): number | undefined {
  if (request.key.length === 1) return request.key.charCodeAt(0);
  if (request.key === "Shift" && request.code === "ShiftLeft") return 0xffe1;
  if (request.key === "Shift" && request.code === "ShiftRight") return 0xffe2;
  return {
    Backspace: 0xff08,
    Tab: 0xff09,
    Enter: 0xff0d,
    Escape: 0xff1b,
    Delete: 0xffff,
    ArrowLeft: 0xff51,
    ArrowUp: 0xff52,
    ArrowRight: 0xff53,
    ArrowDown: 0xff54,
    PageUp: 0xff55,
    PageDown: 0xff56,
    " ": 0x20,
  }[request.key as keyof Record<string, number>];
}

export function rimeKeyMask(
  request: Pick<ImeKeyRequest, "shift" | "ctrl" | "alt" | "meta" | "release">,
): number {
  let mask = 0;
  if (request.shift) mask |= 1;
  if (request.ctrl) mask |= 2;
  if (request.alt) mask |= 4;
  if (request.meta) mask |= 8;
  if (request.release) mask |= 1 << 30;
  return mask;
}
