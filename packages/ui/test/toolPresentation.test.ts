import type { EditDiffDisplay } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { presentToolCall } from "../src/tool-presentation";

const DIFF: EditDiffDisplay = {
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: "context", text: "keep" },
        { kind: "removed", text: "old" },
        { kind: "added", text: "new" },
      ],
    },
  ],
  additions: 1,
  deletions: 1,
  truncated: false,
};

describe("tool presentation", () => {
  it("summarizes a skill load and keeps the body out of the header", () => {
    const presentation = presentToolCall({
      toolName: "Skill",
      state: "completed",
      input: { name: "answra-code" },
      output: [
        '<skill_content name="answra-code">',
        "# answra-code",
        "",
        "写代码时的工程规范。",
        "第二行。",
        "",
        "Base directory for this skill: D:/repo/.agents/skills/answra-code",
        "Relative paths in this skill are relative to this base directory.",
        "",
        "<skill_files>",
        "  <file>checklist.md</file>",
        "  <file>examples.md</file>",
        "</skill_files>",
        "</skill_content>",
      ].join("\n"),
    });

    expect(presentation).toMatchObject({
      action: "other",
      category: "skill",
      primary: "answra-code",
      resultLine: "Loaded 2 lines · 2 files",
      expandable: true,
    });
    expect(presentation.details).toEqual([
      {
        kind: "text",
        label: "Skill content",
        text: "写代码时的工程规范。\n第二行。",
        wrap: true,
        truncated: false,
        totalLines: 2,
      },
    ]);
  });

  it("does not report a result while the skill is still loading", () => {
    const presentation = presentToolCall({
      toolName: "skill.load",
      state: "running",
      input: { name: "answra-code" },
    });

    expect(presentation).toMatchObject({
      category: "skill",
      primary: "answra-code",
      details: [],
      expandable: false,
    });
    expect(presentation.resultLine).toBeUndefined();
  });

  it("marks a truncated skill body without leaking the wrapper", () => {
    const presentation = presentToolCall({
      toolName: "Skill",
      state: "completed",
      input: { name: "large" },
      output: [
        '<skill_content name="large">',
        "# large",
        "",
        "body",
        "",
        "Note: content truncated to 12000 characters.",
        "</skill_content>",
      ].join("\n"),
    });

    expect(presentation.resultLine).toBe("Loaded 3 lines · truncated");
    expect(presentation.details[0]).toMatchObject({
      text: "body\n\nNote: content truncated to 12000 characters.",
    });
  });

  it("summarizes a structured Read without exposing file contents", () => {
    const presentation = presentToolCall({
      toolName: "Read",
      state: "completed",
      input: { file_path: "src/a.ts" },
      output: {
        type: "text",
        filePath: "src/a.ts",
        content: "secret",
        numLines: 42,
        startLine: 1,
        totalLines: 42,
      },
    });

    expect(presentation).toMatchObject({
      action: "read",
      category: "read",
      primary: "a.ts",
      secondary: "src",
      resultLine: "Read 42 lines",
      details: [],
      expandable: false,
    });
  });

  it("counts legacy line-numbered Read output", () => {
    const presentation = presentToolCall({
      toolName: "Read",
      state: "completed",
      input: { file_path: "src/a.ts" },
      output: "1\tone\n2\ttwo\n3\tthree",
    });

    expect(presentation.resultLine).toBe("Read 3 lines");
    expect(presentation.details).toEqual([]);
  });

  it("summarizes structured Grep content and keeps bounded details", () => {
    const presentation = presentToolCall({
      toolName: "Grep",
      state: "completed",
      input: { pattern: "needle", path: "src" },
      output: {
        type: "content",
        files: [
          {
            path: "src/a.ts",
            lines: [
              { lineNumber: 3, text: "needle", kind: "match" },
              { lineNumber: 4, text: "context", kind: "context" },
            ],
          },
        ],
        totalMatches: 1,
        shownMatches: 1,
        truncated: false,
        lineNumbers: true,
      },
    });

    expect(presentation).toMatchObject({
      action: "search",
      category: "search",
      primary: "needle",
      secondary: "src",
      resultLine: "Found 1 line",
      expandable: true,
    });
    expect(presentation.details[0]).toMatchObject({
      kind: "text",
      text: "src/a.ts:3:needle\nsrc/a.ts-4-context",
      wrap: false,
      truncated: false,
    });
  });

  it("summarizes Grep files and count modes", () => {
    expect(
      presentToolCall({
        toolName: "Grep",
        state: "completed",
        input: { pattern: "needle" },
        output: { type: "files_with_matches", files: ["a.ts", "b.ts"], truncated: false },
      }),
    ).toMatchObject({ resultLine: "Found 2 files", primary: "needle" });

    const count = presentToolCall({
      toolName: "Grep",
      state: "completed",
      input: { pattern: "needle" },
      output: {
        type: "count",
        counts: [
          { path: "a.ts", count: 2 },
          { path: "b.ts", count: 1 },
        ],
        truncated: false,
      },
    });
    expect(count.resultLine).toBe("Found 3 matches across 2 files");
    expect(count.details[0]).toMatchObject({ text: "a.ts:2\nb.ts:1" });
  });

  it("falls back to legacy Grep text", () => {
    const presentation = presentToolCall({
      toolName: "Grep",
      state: "completed",
      input: { pattern: "needle", output_mode: "content" },
      output: "src/a.ts:1:needle\n[结果达到上限]",
    });

    expect(presentation.resultLine).toBe("Found 1 line");
    expect(presentation.details[0]).toMatchObject({
      text: "src/a.ts:1:needle",
      truncated: true,
    });
  });

  it("summarizes Edit with diff statistics and a diff detail", () => {
    const presentation = presentToolCall({
      toolName: "Edit",
      state: "completed",
      input: { file_path: "src/a.ts", old_string: "old", new_string: "new" },
      output: {
        type: "edited",
        filePath: "src/a.ts",
        replacements: 1,
        replaceAll: false,
        diff: DIFF,
      },
    });

    expect(presentation).toMatchObject({
      action: "edit",
      category: "write",
      primary: "a.ts",
      secondary: "src",
      meta: "+1 -1",
      resultLine: "Added 1 line, removed 1 line",
      expandable: true,
    });
    expect(presentation.details[0]).toEqual({ kind: "diff", diff: DIFF });
  });

  it("marks an empty old_string as a create action", () => {
    const presentation = presentToolCall({
      toolName: "Edit",
      state: "completed",
      input: { file_path: "src/new.ts", old_string: "", new_string: "new" },
      output: { type: "edited", filePath: "src/new.ts", replacements: 1, replaceAll: false },
    });

    expect(presentation.action).toBe("create");
    expect(presentation.resultLine).toBe("Replaced 1 occurrence");
    expect(presentation.details).toEqual([]);
  });

  it("summarizes a created Edit as Created file", () => {
    const presentation = presentToolCall({
      toolName: "Edit",
      state: "completed",
      input: { file_path: "src/new.ts", old_string: "", new_string: "new\n" },
      output: {
        type: "created",
        filePath: "src/new.ts",
        replacements: 0,
        replaceAll: false,
        diff: DIFF,
      },
    });

    expect(presentation).toMatchObject({
      action: "create",
      category: "write",
      primary: "new.ts",
      secondary: "src",
      resultLine: "Created file",
      expandable: true,
    });
    expect(presentation.details[0]).toEqual({ kind: "diff", diff: DIFF });
  });

  it("summarizes RunCommand success, empty output, failure, and timeout", () => {
    const success = presentToolCall({
      toolName: "RunCommand",
      state: "completed",
      input: { command: "pnpm test" },
      output: {
        kind: "result",
        result: { stdout: "ok\n", stderr: "", outcome: { type: "exit", exitCode: 0 } },
      },
    });
    expect(success).toMatchObject({
      action: "run",
      category: "command",
      primary: "pnpm test",
      expandable: true,
    });
    expect(success.resultLine).toBeUndefined();
    expect(success.details[0]).toMatchObject({ text: "ok", wrap: false });

    expect(
      presentToolCall({
        toolName: "RunCommand",
        state: "completed",
        input: { command: "true" },
        output: {
          kind: "result",
          result: { stdout: "", stderr: "", outcome: { type: "exit", exitCode: 0 } },
        },
      }),
    ).toMatchObject({ resultLine: "(No output)", details: [] });

    expect(
      presentToolCall({
        toolName: "RunCommand",
        state: "failed",
        input: { command: "false" },
        output: {
          kind: "result",
          result: { stdout: "", stderr: "boom", outcome: { type: "exit", exitCode: 1 } },
        },
      }),
    ).toMatchObject({ resultLine: "Exit code 1", details: [{ kind: "text", text: "boom" }] });

    const timeout = presentToolCall({
      toolName: "RunCommand",
      state: "completed",
      input: { command: "sleep 10" },
      output: {
        kind: "result",
        result: { stdout: "", stderr: "", outcome: { type: "timeout", exitCode: null } },
      },
    });
    expect(timeout.resultLine).toBe("Timed out");
    expect(timeout.details).toEqual([
      { kind: "notice", tone: "warning", text: "Command timed out." },
    ]);
  });

  it("summarizes a RunCommand session snapshot", () => {
    const presentation = presentToolCall({
      toolName: "RunCommand",
      state: "running",
      input: { command: "pnpm dev" },
      output: {
        kind: "session",
        snapshot: {
          status: "running",
          sessionId: "shell-1",
          stdout: "starting\n",
          stderr: "",
          outputTruncated: false,
        },
      },
    });

    expect(presentation).toMatchObject({
      primary: "pnpm dev",
      meta: "session shell-1",
      resultLine: "Running…",
    });
    expect(presentation.details[0]).toMatchObject({ text: "starting" });
  });

  it("parses legacy RunCommand status lines", () => {
    const presentation = presentToolCall({
      toolName: "RunCommand",
      state: "completed",
      input: { command: "pnpm test" },
      output: "Exit code: 1\nfailed",
    });

    expect(presentation.resultLine).toBe("Exit code 1");
    expect(presentation.details[0]).toMatchObject({ text: "failed" });
  });

  it("summarizes a RunCommand session continuation", () => {
    const snapshot = {
      status: "completed",
      sessionId: "shell-1",
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
      outputTruncated: false,
    };

    expect(
      presentToolCall({
        toolName: "RunCommand",
        state: "completed",
        input: { sessionId: "shell-1", chars: "y\n" },
        output: { kind: "session", snapshot },
      }),
    ).toMatchObject({
      action: "run",
      category: "command",
      primary: "shell-1",
      meta: "stdin y",
    });

    expect(
      presentToolCall({
        toolName: "RunCommand",
        state: "completed",
        input: { sessionId: "shell-1" },
        output: { kind: "session", snapshot },
      }).resultLine,
    ).toBeUndefined();
  });

  it("keeps unknown tools safe and expandable", () => {
    const presentation = presentToolCall({
      toolName: "Mystery",
      state: "completed",
      title: "Mystery",
      input: { path: "a" },
      output: { value: 1 },
    });

    expect(presentation).toMatchObject({
      action: "other",
      category: "other",
      primary: "Mystery",
      expandable: true,
    });
    expect(presentation.details.map((detail) => detail.kind)).toEqual(["text", "text"]);
  });

  it("accepts legacy workspace tool ids", () => {
    expect(
      presentToolCall({
        toolName: "workspace.read",
        state: "completed",
        input: { file_path: "a.ts" },
        output: { type: "text", numLines: 1, totalLines: 1 },
      }),
    ).toMatchObject({ action: "read", primary: "a.ts" });
  });
});
