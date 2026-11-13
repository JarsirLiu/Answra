import { describe, expect, it, vi } from "vitest";
import { createClipboardWriter, nativeClipboardCommands } from "../src/tui/interaction/clipboard";

function createStdout() {
  return { write: vi.fn() } as unknown as NodeJS.WritableStream;
}

describe("clipboard", () => {
  it("writes OSC 52 and runs the platform fallback outside SSH", () => {
    const stdout = createStdout();
    const run = vi.fn();
    const writer = createClipboardWriter(stdout, { platform: "win32", env: {}, run });

    writer.write("你好");

    expect(stdout.write).toHaveBeenCalledWith(
      `\x1b]52;c;${Buffer.from("你好", "utf8").toString("base64")}\x07`,
    );
    expect(run).toHaveBeenCalledWith(
      nativeClipboardCommands("win32")[0],
      "你好",
      expect.any(Function),
    );
  });

  it("skips local fallback over SSH and for empty text", () => {
    const stdout = createStdout();
    const run = vi.fn();
    const writer = createClipboardWriter(stdout, {
      platform: "linux",
      env: { SSH_CONNECTION: "1 2 3 4" },
      run,
    });

    writer.write("text");
    writer.write("");

    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("tries the next Linux command when the previous one fails", () => {
    const run = vi.fn((command: { command: string }, _text: string, onError: () => void) => {
      if (command.command === "wl-copy") onError();
    });
    const writer = createClipboardWriter(createStdout(), {
      platform: "linux",
      env: {},
      run,
    });

    writer.write("text");

    expect(run.mock.calls.map(([command]) => command.command)).toEqual(["wl-copy", "xclip"]);
  });

  it("returns no native commands for unsupported platforms", () => {
    expect(nativeClipboardCommands("aix")).toEqual([]);
    expect(nativeClipboardCommands("darwin")).toEqual([{ command: "pbcopy", args: [] }]);
    expect(nativeClipboardCommands("linux").map((command) => command.command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
  });
});
