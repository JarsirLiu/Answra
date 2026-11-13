import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWheelInput, parseWheelInput } from "../src/tui/wheelInput";

describe("wheel input", () => {
  it("extracts SGR wheel events and preserves surrounding text", () => {
    expect(parseWheelInput("a\x1b[<64;10;5Mb\x1b[<65;10;5Mc")).toEqual({
      text: "abc",
      pending: "",
      directions: [-1, 1],
    });
  });

  it("keeps a split SGR sequence pending until the final byte arrives", () => {
    const first = parseWheelInput("a\x1b[<64;10", "");
    expect(first).toEqual({ text: "a", pending: "\x1b[<64;10", directions: [] });

    expect(parseWheelInput(";5M", first.pending)).toEqual({
      text: "",
      pending: "",
      directions: [-1],
    });
  });

  it("filters clicks and parses legacy X10 wheel bytes", () => {
    const x10Up = `${String.fromCharCode(27)}[M${String.fromCharCode(96, 33, 33)}`;
    const x10Down = `${String.fromCharCode(27)}[M${String.fromCharCode(97, 33, 33)}`;
    expect(parseWheelInput(`\x1b[<0;10;5M${x10Up}x${x10Down}`)).toEqual({
      text: "x",
      pending: "",
      directions: [-1, 1],
    });
  });

  it("enables mouse mode, forwards text, and cleans up", () => {
    const fakeInput = Object.assign(new EventEmitter(), {
      isTTY: true,
      setEncoding: vi.fn(),
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    });
    const input = fakeInput as unknown as NodeJS.ReadableStream;
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;

    const wheel = createWheelInput(input, output);
    if (wheel === undefined) throw new Error("wheel input should be enabled");

    const directions: number[] = [];
    wheel.source.subscribe((direction) => directions.push(direction));
    const received: string[] = [];
    wheel.stdin.on("data", (chunk: string) => received.push(chunk));

    fakeInput.emit("data", "a\x1b[<64;1;1Mb");

    expect(output.write).toHaveBeenCalledWith("\x1b[?1000h\x1b[?1006h");
    expect(directions).toEqual([-1]);
    expect(received.join("")).toBe("ab");

    wheel.dispose();
    expect(output.write).toHaveBeenCalledWith("\x1b[?1006l\x1b[?1000l");
  });

  it("does not enable mouse mode without a TTY", () => {
    const input = Object.assign(new EventEmitter(), { isTTY: false });
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    expect(createWheelInput(input as unknown as NodeJS.ReadableStream, output)).toBeUndefined();
  });
});
