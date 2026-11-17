import { describe, expect, it } from "vitest";
import {
  completeTuiCommand,
  findTuiCommand,
  suggestTuiCommands,
  TUI_COMMANDS,
  tuiCommandArgumentHint,
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
    expect(parseTuiCommand("/new")).toMatchObject({ command: { kind: "new" }, args: [] });
    expect(parseTuiCommand("/sessions")).toMatchObject({ command: { kind: "sessions" }, args: [] });
    expect(parseTuiCommand("/resume abc")).toMatchObject({
      command: { kind: "resume" },
      args: ["abc"],
    });
    expect(parseTuiCommand("/delete abc")).toMatchObject({
      command: { kind: "delete" },
      args: ["abc"],
    });
    expect(parseTuiCommand("/compact")).toMatchObject({ command: { kind: "compact" }, args: [] });
    expect(parseTuiCommand("/compact 保留迁移决定")).toMatchObject({
      command: { kind: "compact" },
      args: ["保留迁移决定"],
    });
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
      "new",
      "sessions",
      "resume",
      "delete",
      "compact",
      "config",
      "model",
      "login",
      "logout",
      "status",
      "remote",
      "exit",
    ]);
    expect(suggestTuiCommands("co").map((command) => command.name)).toEqual(["compact", "config"]);
    expect(suggestTuiCommands("mo").map((command) => command.name)).toEqual(["model"]);
    expect(suggestTuiCommands("log").map((command) => command.name)).toEqual(["login", "logout"]);
    expect(suggestTuiCommands("qu").map((command) => command.name)).toEqual(["exit"]);
    expect(suggestTuiCommands("压缩").map((command) => command.name)).toEqual(["compact"]);
    expect(suggestTuiCommands("zzz")).toEqual([]);
  });

  it("keeps exact names and aliases ahead of partial matches", () => {
    expect(suggestTuiCommands("model").map((command) => command.name)).toEqual(["model"]);
    expect(suggestTuiCommands("quit").map((command) => command.name)).toEqual(["exit"]);
  });

  it("puts recently executed commands first for an empty query", () => {
    expect(suggestTuiCommands("", ["model", "help"]).map((command) => command.name)).toEqual([
      "model",
      "help",
      "clear",
      "new",
      "sessions",
      "resume",
      "delete",
      "compact",
      "config",
      "login",
      "logout",
      "status",
      "remote",
      "exit",
    ]);
  });

  it("shows argument hints only before real arguments are typed", () => {
    expect(tuiCommandArgumentHint("/compact")).toBe("[instructions]");
    expect(tuiCommandArgumentHint("/compact ")).toBe("[instructions]");
    expect(tuiCommandArgumentHint("/resume ")).toBe("<ID|前缀>");
    expect(tuiCommandArgumentHint("/compact  ")).toBeUndefined();
    expect(tuiCommandArgumentHint("/compact 保留迁移")).toBeUndefined();
    expect(tuiCommandArgumentHint("/help")).toBeUndefined();
    expect(tuiCommandArgumentHint("/unknown")).toBeUndefined();
    expect(tuiCommandArgumentHint("compact")).toBeUndefined();
  });

  it("completes command names and leaves room for arguments", () => {
    expect(completeTuiCommand(requireCommand("help"))).toBe("/help");
    expect(completeTuiCommand(requireCommand("clear"))).toBe("/clear");
    expect(completeTuiCommand(requireCommand("compact"))).toBe("/compact ");
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

describe("catalog access", () => {
  it("keeps view-only commands available while a run is active", () => {
    for (const name of ["help", "status", "sessions", "resume"]) {
      expect(requireCommand(name).access).toEqual({ whileRunning: "allow" });
    }
  });

  it("scopes session mutations to the active run and global mutations to all runs", () => {
    for (const name of ["clear", "new", "delete"]) {
      expect(requireCommand(name).access).toMatchObject({
        whileRunning: "deny",
        scope: "active",
      });
    }
    for (const name of ["model", "config", "compact", "exit"]) {
      expect(requireCommand(name).access).toMatchObject({
        whileRunning: "deny",
        scope: "all",
      });
    }
  });
});
