import { describe, expect, it } from "vitest";
import { parseTuiCommand } from "../src/tui/commands";

describe("parseTuiCommand", () => {
  it("parses local commands with surrounding whitespace", () => {
    expect(parseTuiCommand("  /help ")).toEqual({ kind: "help" });
    expect(parseTuiCommand("/clear")).toEqual({ kind: "clear" });
    expect(parseTuiCommand("/quit")).toEqual({ kind: "exit" });
  });

  it("reports unknown slash commands", () => {
    expect(parseTuiCommand("/unknown")).toEqual({ kind: "unknown", name: "unknown" });
    expect(parseTuiCommand("/")).toEqual({ kind: "unknown", name: "" });
  });

  it("parses model commands and their arguments", () => {
    expect(parseTuiCommand("/model")).toEqual({ kind: "model", args: [] });
    expect(parseTuiCommand("/model qwen")).toEqual({ kind: "model", args: ["qwen"] });
    expect(parseTuiCommand(" /model add http://127.0.0.1:1234/v1 qwen qwen-vl ")).toEqual({
      kind: "model",
      args: ["add", "http://127.0.0.1:1234/v1", "qwen", "qwen-vl"],
    });
  });

  it("leaves normal prompts untouched", () => {
    expect(parseTuiCommand("fix the bug")).toBeUndefined();
    expect(parseTuiCommand("/path/to/file")).toEqual({ kind: "unknown", name: "path/to/file" });
  });
});
