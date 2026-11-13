import { describe, expect, it } from "vitest";
import {
  completeTuiCommand,
  findTuiCommand,
  suggestTuiCommands,
  TUI_COMMANDS,
  tuiCommandPrefix,
} from "../src/tui/commands/catalog";
import { parseTuiCommand } from "../src/tui/commands/parse";

function requireCommand(name: string) {
  const command = findTuiCommand(name);
  if (command === undefined) throw new Error(`missing command: ${name}`);
  return command;
}

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

  it("suggests every local command and filters by name or alias", () => {
    expect(suggestTuiCommands("").map((command) => command.name)).toEqual([
      "help",
      "clear",
      "model",
      "exit",
    ]);
    expect(suggestTuiCommands("mo").map((command) => command.name)).toEqual(["model"]);
    expect(suggestTuiCommands("qu").map((command) => command.name)).toEqual(["exit"]);
    expect(suggestTuiCommands("zzz")).toEqual([]);
  });

  it("completes command names and leaves room for arguments", () => {
    expect(completeTuiCommand(requireCommand("help"))).toBe("/help");
    expect(completeTuiCommand(requireCommand("clear"))).toBe("/clear");
    expect(completeTuiCommand(requireCommand("model"))).toBe("/model ");
    expect(completeTuiCommand(requireCommand("quit"))).toBe("/exit");
  });

  it("only treats a leading slash without whitespace as a command prefix", () => {
    expect(tuiCommandPrefix("/")).toBe("");
    expect(tuiCommandPrefix("/mo")).toBe("mo");
    expect(tuiCommandPrefix("/model qwen")).toBeUndefined();
    expect(tuiCommandPrefix(" /model")).toBeUndefined();
    expect(tuiCommandPrefix("fix")).toBeUndefined();
  });

  it("keeps every command in the help catalog", () => {
    expect(TUI_COMMANDS.every((command) => command.helpLines.length > 0)).toBe(true);
  });
});
