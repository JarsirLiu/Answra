import { describe, expect, it } from "vitest";
import {
  completeTuiCommand,
  findTuiCommand,
  suggestTuiCommands,
  TUI_COMMANDS,
  tuiCommandHelpUsage,
  tuiCommandPrefix,
} from "../../../src/tui/commands/catalog";
import { TUI_HELP_LINES } from "../../../src/tui/commands/help";
import { parseTuiCommand } from "../../../src/tui/commands/parse";

function requireCommand(name: string) {
  const command = findTuiCommand(name);
  if (command === undefined) throw new Error(`missing command: ${name}`);
  return command;
}

describe("parseTuiCommand", () => {
  it("parses local commands with surrounding whitespace", () => {
    expect(parseTuiCommand("  /help ")).toMatchObject({ command: { kind: "help" }, args: [] });
    expect(parseTuiCommand("/clear")).toMatchObject({ command: { kind: "clear" }, args: [] });
    expect(parseTuiCommand("/compact")).toMatchObject({ command: { kind: "compact" }, args: [] });
    expect(parseTuiCommand("/config")).toMatchObject({ command: { kind: "config" }, args: [] });
    expect(parseTuiCommand("/quit")).toMatchObject({ command: { kind: "exit" }, args: [] });
  });

  it("reports unknown slash commands", () => {
    expect(parseTuiCommand("/unknown")).toEqual({ name: "unknown" });
    expect(parseTuiCommand("/")).toEqual({ name: "" });
  });

  it("parses model commands and their arguments", () => {
    expect(parseTuiCommand("/model")).toMatchObject({ command: { kind: "model" }, args: [] });
    expect(parseTuiCommand("/model qwen")).toMatchObject({
      command: { kind: "model" },
      args: ["qwen"],
    });
    expect(parseTuiCommand(" /model add http://127.0.0.1:1234/v1 qwen qwen-vl ")).toMatchObject({
      command: { kind: "model" },
      args: ["add", "http://127.0.0.1:1234/v1", "qwen", "qwen-vl"],
    });
  });

  it("leaves normal prompts untouched", () => {
    expect(parseTuiCommand("fix the bug")).toBeUndefined();
    expect(parseTuiCommand("/path/to/file")).toEqual({ name: "path/to/file" });
  });

  it("suggests every local command and filters by name or alias", () => {
    expect(suggestTuiCommands("").map((command) => command.name)).toEqual([
      "help",
      "clear",
      "compact",
      "config",
      "model",
      "login",
      "logout",
      "status",
      "exit",
    ]);
    expect(suggestTuiCommands("co").map((command) => command.name)).toEqual(["compact", "config"]);
    expect(suggestTuiCommands("mo").map((command) => command.name)).toEqual(["model"]);
    expect(suggestTuiCommands("log").map((command) => command.name)).toEqual(["login", "logout"]);
    expect(suggestTuiCommands("qu").map((command) => command.name)).toEqual(["exit"]);
    expect(suggestTuiCommands("zzz")).toEqual([]);
  });

  it("completes command names and leaves room for arguments", () => {
    expect(completeTuiCommand(requireCommand("help"))).toBe("/help");
    expect(completeTuiCommand(requireCommand("clear"))).toBe("/clear");
    expect(completeTuiCommand(requireCommand("compact"))).toBe("/compact");
    expect(completeTuiCommand(requireCommand("config"))).toBe("/config");
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

  it("derives every help line from the command catalog", () => {
    const helpText = TUI_HELP_LINES.join("\n");
    for (const command of TUI_COMMANDS) {
      expect(helpText).toContain(tuiCommandHelpUsage(command));
      expect(helpText).toContain(command.summary);
      for (const detail of command.helpDetails ?? []) {
        expect(helpText).toContain(detail.usage);
        expect(helpText).toContain(detail.summary);
      }
    }
    expect(helpText).not.toContain("/model add");
  });
});
