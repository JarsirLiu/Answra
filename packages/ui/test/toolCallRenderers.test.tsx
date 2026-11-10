import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditToolCall } from "../src/components/tool-call/renderers/edit";
import { GrepToolCall } from "../src/components/tool-call/renderers/grep";
import { ReadToolCall } from "../src/components/tool-call/renderers/read";
import { RunCommandToolCall } from "../src/components/tool-call/renderers/runCommand";
import { WriteStdinToolCall } from "../src/components/tool-call/renderers/writeStdin";
import { resolveToolCallRenderer } from "../src/components/tool-call/resolveToolCallRenderer";
import { ToolCallFallback } from "../src/components/tool-call/ToolCallFallback";
import type { ToolCallPart } from "../src/components/tool-call/toolCallPart";

function toolPart(
  toolName: string,
  input?: unknown,
  output?: unknown,
  state: ToolCallPart["state"] = "completed",
  errorText?: string,
): ToolCallPart {
  return {
    id: "tool-1",
    kind: "tool",
    toolCallId: "tool-1",
    toolName,
    state,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(errorText === undefined ? {} : { errorText }),
  };
}

function expand(name: RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("tool call renderers", () => {
  it("summarizes a Read result without details or expandable content", () => {
    const { container } = render(
      <ReadToolCall
        part={toolPart(
          "Read",
          { file_path: "src/a.ts" },
          {
            type: "text",
            filePath: "src/a.ts",
            content: "one\ntwo",
            numLines: 2,
            startLine: 1,
            totalLines: 2,
            truncated: false,
          },
        )}
      />,
    );

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("2 行")).toBeNull();
    expect(screen.queryByText("one")).toBeNull();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(container.querySelector("[data-tool-panel]")).toBeNull();
  });

  it("does not render the model-facing Read content", () => {
    const { container } = render(
      <ReadToolCall
        part={toolPart(
          "Read",
          { file_path: "src/a.ts" },
          "<system-reminder>文件内容约 100 tokens，仅显示第 1-2 行（共 9 行）。</system-reminder>\n\n1\tone\n2\ttwo",
        )}
      />,
    );

    expect(screen.queryByText(/system-reminder/)).toBeNull();
    expect(screen.queryByText("内容")).toBeNull();
    expect(screen.queryByText("结果")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("1\tone");
  });

  it("shows a Read failure without details", () => {
    const { container } = render(
      <ReadToolCall
        part={toolPart("Read", { file_path: "missing.ts" }, undefined, "failed", "文件不存在")}
      />,
    );

    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.queryByText("文件不存在")).toBeNull();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
  });

  it("maps the Edit tool name to its renderer", () => {
    expect(resolveToolCallRenderer("Edit")).toBe(EditToolCall);
  });

  it("summarizes an Edit replacement and expands to a diff", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          { file_path: "src/a.ts", old_string: "before", new_string: "after" },
          "The file src/a.ts has been updated successfully. Replaced 1 occurrence. No need to read it again to verify.",
        )}
      />,
    );

    expect(screen.getByRole("button", { name: /Edited a\.ts \+1 -1/ })).toBeInTheDocument();
    expect(screen.queryByText("before")).toBeNull();
    expect(screen.queryByText("after")).toBeNull();

    expand(/Edited a\.ts \+1 -1/);
    expect(screen.getByRole("button", { name: /Edited file/ })).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getAllByText("+1")).toHaveLength(1);
    expect(screen.getAllByText("-1")).toHaveLength(1);
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
    expect(screen.queryByText("替换前")).toBeNull();
    expect(screen.queryByText("替换后")).toBeNull();
  });

  it("labels an Edit with an empty old string as Created", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          { file_path: "src/new.ts", old_string: "", new_string: "one\ntwo" },
          "The file src/new.ts has been created successfully.",
        )}
      />,
    );

    expect(screen.getByRole("button", { name: /Created new\.ts \+2 -0/ })).toBeInTheDocument();

    expand(/Created new\.ts/);
    expect(screen.getByRole("button", { name: /Created file/ })).toBeInTheDocument();
    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("-0")).toBeInTheDocument();
  });

  it("shows Read line numbers in the Edit diff", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          {
            file_path: "src/conversationView.test.ts",
            old_string: [
              '292\t    error: "Cannot connect to API",',
              '293\t    messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming" }],',
              "294\t  };",
            ].join("\n"),
            new_string: [
              '    error: "Cannot connect to API",',
              '    messages: [{ id: "run-2", role: "assistant", text: "", status: "streaming" }],',
              "  };",
            ].join("\n"),
          },
          "The file src/conversationView.test.ts has been updated successfully. Replaced 1 occurrence.",
        )}
      />,
    );

    expand(/Edited/);
    expect(screen.getByText("292")).toBeInTheDocument();
    expect(screen.getAllByText("293")).toHaveLength(2);
    expect(screen.getByText("294")).toBeInTheDocument();
    expect(screen.queryByText(/292\t/)).toBeNull();
  });

  it("copies the replacement text from the diff header", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      render(
        <EditToolCall
          part={toolPart(
            "Edit",
            { file_path: "src/a.ts", old_string: "before", new_string: "after" },
            "The file src/a.ts has been updated successfully. Replaced 1 occurrence.",
          )}
        />,
      );

      expand(/Edited/);
      fireEvent.click(screen.getByRole("button", { name: "复制修改后片段" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("after"));
      expect(screen.getByRole("button", { name: "已复制修改后片段" })).toBeInTheDocument();
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("renders multiple structured hunks with a gap instead of the legacy fragment", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          {
            file_path: "src/a.ts",
            old_string: "legacy-before",
            new_string: "legacy-after",
            replace_all: true,
          },
          {
            type: "edited",
            replacements: 2,
            replaceAll: true,
            diff: {
              hunks: [
                {
                  oldStart: 2,
                  oldLines: 7,
                  newStart: 2,
                  newLines: 7,
                  lines: [
                    { kind: "context", text: "ctx-a-2" },
                    { kind: "context", text: "ctx-a-3" },
                    { kind: "context", text: "ctx-a-4" },
                    { kind: "removed", text: "old-a" },
                    { kind: "added", text: "new-a" },
                    { kind: "context", text: "ctx-a-6" },
                    { kind: "context", text: "ctx-a-7" },
                    { kind: "context", text: "ctx-a-8" },
                  ],
                },
                {
                  oldStart: 20,
                  oldLines: 7,
                  newStart: 20,
                  newLines: 7,
                  lines: [
                    { kind: "context", text: "ctx-b-20" },
                    { kind: "context", text: "ctx-b-21" },
                    { kind: "context", text: "ctx-b-22" },
                    { kind: "removed", text: "old-b" },
                    { kind: "added", text: "new-b" },
                    { kind: "context", text: "ctx-b-24" },
                    { kind: "context", text: "ctx-b-25" },
                    { kind: "context", text: "ctx-b-26" },
                  ],
                },
              ],
              additions: 2,
              deletions: 2,
              truncated: false,
            },
          },
        )}
      />,
    );

    expect(screen.getByRole("button", { name: /Edited a\.ts \+2 -2/ })).toBeInTheDocument();
    expand(/Edited a\.ts/);

    expect(screen.getByText("old-a")).toBeInTheDocument();
    expect(screen.getByText("new-a")).toBeInTheDocument();
    expect(screen.getByText("old-b")).toBeInTheDocument();
    expect(screen.getByText("new-b")).toBeInTheDocument();
    expect(screen.getByText("11 行未修改")).toBeInTheDocument();
    expect(screen.queryByText("legacy-before")).toBeNull();
    expect(screen.queryByText("legacy-after")).toBeNull();
    expect(screen.getByText("2 处替换")).toBeInTheDocument();
  });

  it("falls back to the legacy fragment when a structured diff is malformed", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          { file_path: "src/a.ts", old_string: "before", new_string: "after" },
          {
            type: "edited",
            replacements: 1,
            replaceAll: false,
            diff: { hunks: [{ oldStart: 0 }] },
          },
        )}
      />,
    );

    expand(/Edited/);
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
    expect(screen.queryByText("0 行未修改")).toBeNull();
  });

  it("marks replace_all edits and accepts a structured output", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          {
            file_path: "src/a.ts",
            old_string: "x",
            new_string: "y",
            replace_all: true,
          },
          { type: "edited", replacements: 3, replaceAll: true },
        )}
      />,
    );

    expand(/Edited/);
    expect(screen.getByText("3 处替换")).toBeInTheDocument();
    expect(screen.getByText("x")).toBeInTheDocument();
    expect(screen.getByText("y")).toBeInTheDocument();
  });

  it("shows a business failure returned as model content", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          { file_path: "src/a.ts", old_string: "missing", new_string: "after" },
          "工具调用失败（invalid-input）：旧内容未在文件中找到",
        )}
      />,
    );

    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.queryByText(/旧内容未在文件中找到/)).toBeNull();

    expand(/Edited/);
    expect(screen.getByText("错误")).toBeInTheDocument();
    expect(screen.getByText(/旧内容未在文件中找到/)).toBeInTheDocument();
  });

  it("shows a hard Edit failure with the attempted replacement", () => {
    render(
      <EditToolCall
        part={toolPart(
          "Edit",
          { file_path: "src/a.ts", old_string: "before", new_string: "after" },
          undefined,
          "failed",
          "文件在读取后已被修改",
        )}
      />,
    );

    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.queryByText("文件在读取后已被修改")).toBeNull();

    expand(/Edited/);
    expect(screen.getByText("文件在读取后已被修改")).toBeInTheDocument();
    expect(screen.getByText("编辑未写入文件。")).toBeInTheDocument();
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
  });

  it("renders Grep content matches with line numbers", () => {
    render(
      <GrepToolCall
        part={toolPart(
          "Grep",
          { pattern: "useEffect", path: "src" },
          {
            type: "content",
            files: [
              {
                path: "src/a.ts",
                lines: [
                  { lineNumber: 3, text: "useEffect(() => {", kind: "match" },
                  { lineNumber: 4, text: "  return;", kind: "context" },
                ],
              },
            ],
            totalMatches: 1,
            shownMatches: 1,
            truncated: false,
            lineNumbers: true,
          },
        )}
      />,
    );

    expect(screen.getByText("useEffect")).toBeInTheDocument();
    expect(screen.queryByText("1 处匹配")).toBeNull();

    expand(/搜索/);
    expect(screen.getByText(/1 处匹配/)).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("useEffect(() => {")).toBeInTheDocument();
    expect(screen.getByText("return;")).toBeInTheDocument();
  });

  it("keeps model-facing Grep content in the shared panel", () => {
    const { container } = render(
      <GrepToolCall
        part={toolPart(
          "Grep",
          { pattern: "useEffect", output_mode: "content" },
          "src/a.ts:3:useEffect(() => {\nsrc/a.ts-4-  return;\n[结果达到上限]",
        )}
      />,
    );

    expect(screen.queryByText("匹配")).toBeNull();

    expand(/搜索/);
    expect(screen.getByText("匹配")).toBeInTheDocument();
    expect(screen.getByText("结果达到上限，已截断。")).toBeInTheDocument();
    expect(screen.queryByText("结果")).toBeNull();
    expect(container.querySelector("[data-tool-panel]")?.textContent).toContain(
      "src/a.ts:3:useEffect",
    );
    expect(container.querySelector("pre")).toHaveAttribute("data-wrap", "false");
  });

  it("labels model-facing Grep file results by their output mode", () => {
    render(
      <GrepToolCall part={toolPart("Grep", { pattern: "useEffect" }, "src/a.ts\nsrc/b.ts")} />,
    );

    expand(/搜索/);
    expect(screen.getByText("文件")).toBeInTheDocument();
    expect(screen.getByText("2 个文件")).toBeInTheDocument();
    expect(screen.queryByText("结果")).toBeNull();
  });

  it("strips the model-facing exit status and renders one Shell panel", () => {
    const { container } = render(
      <RunCommandToolCall
        part={toolPart(
          "RunCommand",
          { command: "npm test", workdir: "packages/ui" },
          "Exit code: 0\nhello\nwarn",
        )}
      />,
    );

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.queryByText("packages/ui")).toBeNull();
    expect(screen.queryByText("完成")).toBeNull();
    expect(screen.queryByText("Shell")).toBeNull();
    expect(screen.queryByText(/Exit code/)).toBeNull();

    expand(/ran/);
    expect(screen.getByText("Shell")).toBeInTheDocument();
    expect(screen.queryByText(/Exit code/)).toBeNull();
    expect(container.querySelector("[data-tool-panel]")?.textContent).toContain("Shell");
    expect(container.querySelector("pre")).toHaveAttribute("data-wrap", "false");
    expect(container.querySelector("pre")?.textContent).toBe("$ npm test\nhello\nwarn");
  });

  it("labels an active RunCommand as running and pulses the command line", () => {
    render(
      <RunCommandToolCall
        part={toolPart("RunCommand", { command: "npm test" }, undefined, "running")}
      />,
    );

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.queryByText("运行中")).toBeNull();
    expect(screen.getByText("npm test")).toHaveAttribute("data-running", "true");
  });

  it("keeps the failure label for a failed RunCommand", () => {
    render(
      <RunCommandToolCall
        part={toolPart("RunCommand", { command: "npm test" }, undefined, "failed", "exit 1")}
      />,
    );

    expect(screen.getByText("ran")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("keeps a RunCommand with no stream output to the command line", () => {
    const { container } = render(
      <RunCommandToolCall
        part={toolPart(
          "RunCommand",
          { command: "dir" },
          "Command completed successfully with no output.\nExit code: 0",
        )}
      />,
    );

    expand(/ran/);
    expect(screen.queryByText(/Exit code/)).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("$ dir");
  });

  it("renders a WriteStdin session snapshot", () => {
    const { container } = render(
      <WriteStdinToolCall
        part={toolPart(
          "WriteStdin",
          { sessionId: "sess-1", chars: "y\n" },
          {
            status: "running",
            sessionId: "sess-1",
            stdout: "started\n",
            stderr: "",
            exitCode: null,
          },
        )}
      />,
    );

    expect(screen.getByText("sess-1")).toBeInTheDocument();
    expect(screen.queryByText(/会话运行中/)).toBeNull();

    expand(/写入/);
    expect(screen.getAllByText(/会话运行中/).length).toBeGreaterThan(0);
    expect(screen.getByText("started")).toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toBe("y\n");
  });

  it("parses the model-facing WriteStdin JSON snapshot", () => {
    const snapshot = {
      status: "completed",
      sessionId: "sess-1",
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
    };
    const { container } = render(
      <WriteStdinToolCall
        part={toolPart("WriteStdin", { sessionId: "sess-1" }, JSON.stringify(snapshot))}
      />,
    );

    expand(/写入/);
    expect(screen.getByText("stdout")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.queryByText("结果")).toBeNull();
    expect(container.querySelector("[data-tool-panel]")?.textContent).toContain("done");
  });

  it("keeps unknown tools behind a fallback card with formatted input and output", () => {
    const { container } = render(
      <ToolCallFallback part={toolPart("Deploy", { target: "prod" }, { ok: true })} />,
    );

    expect(screen.getByText("工具")).toBeInTheDocument();
    expect(screen.getByText("Deploy")).toBeInTheDocument();

    expand(/工具/);
    const details = [...container.querySelectorAll("pre")]
      .map((element) => element.textContent)
      .join("\n");
    expect(details).toContain('"target": "prod"');
    expect(details).toContain('"ok": true');
  });
});
