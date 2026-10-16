import { afterEach, describe, expect, it, vi } from "vitest";

const CLASS_NAME = "Chrome_WidgetWin_1";

const native = vi.hoisted(() => ({
  getForegroundWindow: vi.fn(() => 0x1n),
  getWindowThreadProcessId: vi.fn((_handle: unknown, out: number[]) => {
    out[0] = process.pid;
    return 1;
  }),
  getClassNameW: vi.fn((_handle: unknown, buffer: Buffer) => {
    buffer.write("Chrome_WidgetWin_1", 0, "utf16le");
    return "Chrome_WidgetWin_1".length;
  }),
  // Mirrors the real hazard: Koffi dereferences the buffer as a string pointer
  // for `str16`, so an unbounded decode must never be accepted here.
  decode: vi.fn((source: Buffer, type: string, length?: number) => {
    if (type !== "char16_t" || length === undefined)
      throw new Error(`unsafe decode: type=${type} length=${length}`);
    return source.toString("utf16le", 0, length * 2);
  }),
}));

vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: () => null } }));
vi.mock("koffi", () => ({
  default: {
    load: () => ({
      func: (prototype: string) => {
        if (prototype.includes("GetForegroundWindow")) return native.getForegroundWindow;
        if (prototype.includes("GetWindowThreadProcessId")) return native.getWindowThreadProcessId;
        if (prototype.includes("GetClassNameW")) return native.getClassNameW;
        throw new Error(`unexpected native function: ${prototype}`);
      },
    }),
    decode: native.decode,
  },
}));

describe("foreground window diagnostics", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    vi.clearAllMocks();
  });

  it("reads the class name as a bounded UTF-16 buffer instead of a string pointer", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { describeForegroundWindow, isCurrentProcessForeground } = await import(
      "../src/main/windowForeground"
    );

    expect(isCurrentProcessForeground()).toBe(true);
    expect(describeForegroundWindow()).toEqual({
      pid: process.pid,
      className: CLASS_NAME,
      isOwnProcess: true,
    });
    expect(native.getClassNameW).toHaveBeenCalledWith(expect.anything(), expect.any(Buffer), 256);
    expect(native.decode).toHaveBeenCalledWith(expect.any(Buffer), "char16_t", CLASS_NAME.length);
  });

  it("skips the class name when Windows reports no characters", async () => {
    native.getClassNameW.mockReturnValueOnce(0);
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { describeForegroundWindow } = await import("../src/main/windowForeground");

    expect(describeForegroundWindow()).toEqual({
      pid: process.pid,
      className: undefined,
      isOwnProcess: true,
    });
    expect(native.decode).not.toHaveBeenCalled();
  });

  it("stays inert on platforms without the Win32 bindings", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.resetModules();
    const { describeForegroundWindow } = await import("../src/main/windowForeground");

    expect(describeForegroundWindow()).toEqual({});
    expect(native.getForegroundWindow).not.toHaveBeenCalled();
  });
});
