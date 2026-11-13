import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPointerInput, parsePointerInput } from "../../../src/tui/interaction/pointerInput";

describe("pointer input", () => {
  it("extracts SGR wheel events with zero-based coordinates and preserves text", () => {
    expect(parsePointerInput("a\x1b[<64;10;5Mb\x1b[<65;10;5Mc")).toEqual({
      text: "abc",
      pending: "",
      events: [
        { kind: "wheel", direction: -1, point: { row: 4, col: 9 } },
        { kind: "wheel", direction: 1, point: { row: 4, col: 9 } },
      ],
    });
  });

  it("keeps a split SGR sequence pending until the final byte arrives", () => {
    const first = parsePointerInput("a\x1b[<64;10", "");
    expect(first).toEqual({ text: "a", pending: "\x1b[<64;10", events: [] });

    expect(parsePointerInput(";5M", first.pending)).toEqual({
      text: "",
      pending: "",
      events: [{ kind: "wheel", direction: -1, point: { row: 4, col: 9 } }],
    });
  });

  it("parses left-button press, drag, and release", () => {
    expect(parsePointerInput("\x1b[<0;3;4M\x1b[<32;5;6M\x1b[<0;5;6m")).toEqual({
      text: "",
      pending: "",
      events: [
        { kind: "press", point: { row: 3, col: 2 } },
        { kind: "drag", point: { row: 5, col: 4 } },
        { kind: "release", point: { row: 5, col: 4 } },
      ],
    });
  });

  it("ignores right/middle/modified clicks and horizontal wheel events", () => {
    const data = "\x1b[<1;1;1M\x1b[<2;1;1M\x1b[<4;1;1M\x1b[<66;1;1M\x1b[<67;1;1M";
    expect(parsePointerInput(data)).toEqual({ text: "", pending: "", events: [] });
  });

  it("parses legacy X10 wheel bytes and strips non-wheel mouse sequences", () => {
    const x10Up = `\x1b[M${String.fromCharCode(96, 33, 33)}`;
    const x10Down = `\x1b[M${String.fromCharCode(97, 33, 33)}`;
    const x10Click = `\x1b[M${String.fromCharCode(32, 33, 33)}`;
    expect(parsePointerInput(`${x10Click}\x1b[<2;10;5M${x10Up}x${x10Down}`)).toEqual({
      text: "x",
      pending: "",
      events: [
        { kind: "wheel", direction: -1, point: { row: 0, col: 0 } },
        { kind: "wheel", direction: 1, point: { row: 0, col: 0 } },
      ],
    });
  });

  it("enables drag tracking, forwards text, emits events, and cleans up", () => {
    const fakeInput = Object.assign(new EventEmitter(), {
      isTTY: true,
      setEncoding: vi.fn(),
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    });
    const input = fakeInput as unknown as NodeJS.ReadableStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;

    const pointer = createPointerInput(input, output);
    if (pointer === undefined) throw new Error("pointer input should be enabled");

    const events: unknown[] = [];
    pointer.source.subscribe((event) => events.push(event));
    const received: string[] = [];
    pointer.stdin.on("data", (chunk: string) => received.push(chunk));

    fakeInput.emit("data", "a\x1b[<0;2;3Mb");

    expect(output.write).toHaveBeenCalledWith("\x1b[?1002h\x1b[?1006h");
    expect(events).toEqual([{ kind: "press", point: { row: 2, col: 1 } }]);
    expect(received.join("")).toBe("ab");

    pointer.dispose();
    expect(output.write).toHaveBeenCalledWith("\x1b[?1006l\x1b[?1002l");
  });

  it("does not enable mouse mode without a TTY", () => {
    const input = Object.assign(new EventEmitter(), { isTTY: false });
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    expect(createPointerInput(input as unknown as NodeJS.ReadableStream, output)).toBeUndefined();
  });
});
