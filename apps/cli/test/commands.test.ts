import { describe, expect, it } from "vitest";
import { parseTuiCommand } from "../src/tui/commands";

describe("parseTuiCommand", () => {
  it("parses local commands with surrounding whitespace", () => {
    expect(parseTuiCommand("  /help ")).toEqual({ kind: "help" });
    expect(parseTuiCommand("/clear")).toEqual({ kind: "clear" });
    expect(parseTuiCommand("/quit")).toEqual({ kind: "exit" });
  });

  it("reports unknown slash commands", () => {
    expect(parseTuiCommand("/model")).toEqual({ kind: "unknown", name: "model" });
    expect(parseTuiCommand("/")).toEqual({ kind: "unknown", name: "" });
  });

  it("leaves normal prompts untouched", () => {
    expect(parseTuiCommand("fix the bug")).toBeUndefined();
    expect(parseTuiCommand("/path/to/file")).toEqual({ kind: "unknown", name: "path/to/file" });
  });
});
