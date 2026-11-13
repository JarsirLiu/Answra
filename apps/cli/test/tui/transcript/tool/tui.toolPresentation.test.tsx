import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Transcript } from "../../../../src/tui/transcript/Transcript";
import { nextFrame } from "../../tuiTestHarness";

describe("TUI tool presentation", () => {
  it("renders Read as a Claude-style summary without file contents", async () => {
    const instance = render(
      <Transcript
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "",
              status: "complete",
              images: [],
              parts: [
                {
                  id: "tool-1",
                  kind: "tool",
                  toolCallId: "call-1",
                  toolName: "Read",
                  state: "completed",
                  input: { file_path: "src/a.ts" },
                  output: {
                    type: "text",
                    filePath: "src/a.ts",
                    content: "SECRET_CONTENT",
                    numLines: 42,
                    startLine: 1,
                    totalLines: 42,
                  },
                },
              ],
            },
          ],
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("Read(src/a.ts)");
    expect(frame).toContain("Read 42 lines");
    expect(frame).not.toContain("SECRET_CONTENT");
    instance.unmount();
  });

  it("keeps Grep matches collapsed until Ctrl+O expands the tool", async () => {
    const view = {
      eventRevision: 0,
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "",
          status: "complete" as const,
          images: [],
          parts: [
            {
              id: "tool-1",
              kind: "tool" as const,
              toolCallId: "call-1",
              toolName: "Grep",
              state: "completed" as const,
              input: { pattern: "needle", path: "src" },
              output: {
                type: "content",
                files: [
                  {
                    path: "src/a.ts",
                    lines: [{ lineNumber: 3, text: "needle found", kind: "match" }],
                  },
                ],
                totalMatches: 1,
                shownMatches: 1,
                truncated: false,
                lineNumbers: true,
              },
            },
          ],
        },
      ],
    };

    const collapsed = render(<Transcript view={view} workspaceRoot="D:\\workspace" />);
    await nextFrame();
    expect(collapsed.lastFrame()).toContain('Search(pattern: "needle", path: "src")');
    expect(collapsed.lastFrame()).toContain("Found 1 line");
    expect(collapsed.lastFrame()).toContain("ctrl+o to expand");
    expect(collapsed.lastFrame()).not.toContain("needle found");
    collapsed.unmount();

    const expanded = render(
      <Transcript expandThinking view={view} workspaceRoot="D:\\workspace" />,
    );
    await nextFrame();
    expect(expanded.lastFrame()).toContain("needle found");
    expanded.unmount();
  });

  it("renders RunCommand output under the result gutter", async () => {
    const instance = render(
      <Transcript
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "",
              status: "complete",
              images: [],
              parts: [
                {
                  id: "tool-1",
                  kind: "tool",
                  toolCallId: "call-1",
                  toolName: "RunCommand",
                  state: "completed",
                  input: { command: "pnpm test" },
                  output: {
                    kind: "result",
                    result: {
                      stdout: "all tests passed",
                      stderr: "",
                      outcome: { type: "exit", exitCode: 0 },
                    },
                  },
                },
              ],
            },
          ],
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("Bash(pnpm test)");
    expect(frame).toContain("Done");
    expect(frame).toContain("all tests passed");
    instance.unmount();
  });

  it("renders Edit as Update with a condensed diff", async () => {
    const instance = render(
      <Transcript
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "",
              status: "complete",
              images: [],
              parts: [
                {
                  id: "tool-1",
                  kind: "tool",
                  toolCallId: "call-1",
                  toolName: "Edit",
                  state: "completed",
                  input: { file_path: "src/a.ts", old_string: "old", new_string: "new" },
                  output: {
                    type: "edited",
                    filePath: "src/a.ts",
                    replacements: 1,
                    replaceAll: false,
                    diff: {
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
                    },
                  },
                },
              ],
            },
          ],
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    const frame = instance.lastFrame();
    expect(frame).toContain("Update(src/a.ts)");
    expect(frame).toContain("Added 1 line, removed 1 line");
    expect(frame).toContain("+1 -1");
    expect(frame).toContain("-old");
    expect(frame).toContain("+new");
    instance.unmount();
  });

  it("groups consecutive Read and Grep calls into one row until Ctrl+O", async () => {
    const view = {
      eventRevision: 0,
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "",
          status: "complete" as const,
          images: [],
          parts: [
            {
              id: "tool-1",
              kind: "tool" as const,
              toolCallId: "call-1",
              toolName: "Read",
              state: "completed" as const,
              input: { file_path: "src/a.ts" },
              output: {
                type: "text",
                filePath: "src/a.ts",
                content: "a",
                numLines: 10,
                startLine: 1,
                totalLines: 10,
              },
            },
            {
              id: "tool-2",
              kind: "tool" as const,
              toolCallId: "call-2",
              toolName: "Read",
              state: "completed" as const,
              input: { file_path: "src/b.ts" },
              output: {
                type: "text",
                filePath: "src/b.ts",
                content: "b",
                numLines: 20,
                startLine: 1,
                totalLines: 20,
              },
            },
            {
              id: "tool-3",
              kind: "tool" as const,
              toolCallId: "call-3",
              toolName: "Grep",
              state: "completed" as const,
              input: { pattern: "needle", path: "src" },
              output: {
                type: "content",
                files: [
                  {
                    path: "src/a.ts",
                    lines: [{ lineNumber: 3, text: "needle found", kind: "match" }],
                  },
                ],
                totalMatches: 1,
                shownMatches: 1,
                truncated: false,
                lineNumbers: true,
              },
            },
          ],
        },
      ],
    };

    const collapsed = render(<Transcript view={view} workspaceRoot="D:\\workspace" />);
    await nextFrame();
    expect(collapsed.lastFrame()).toContain("Read 2 files, searched 1 pattern");
    expect(collapsed.lastFrame()).not.toContain("Read(src/a.ts)");
    collapsed.unmount();

    const expanded = render(
      <Transcript expandThinking view={view} workspaceRoot="D:\\workspace" />,
    );
    await nextFrame();
    expect(expanded.lastFrame()).toContain("Read(src/a.ts)");
    expect(expanded.lastFrame()).toContain('Search(pattern: "needle", path: "src")');
    expanded.unmount();
  });

  it("renders the welcome state and transcript errors", async () => {
    const instance = render(
      <Transcript
        localError="send failed"
        notice={["会话已清除。"]}
        view={{
          eventRevision: 0,
          messages: [
            {
              id: "user-1",
              role: "user",
              text: "find the bug",
              status: "complete",
            },
          ],
          error: "model failed",
        }}
        workspaceRoot="D:\\workspace"
      />,
    );
    await nextFrame();

    expect(instance.lastFrame()).toContain("find the bug");
    expect(instance.lastFrame()).toContain("model failed");
    expect(instance.lastFrame()).toContain("send failed");
    expect(instance.lastFrame()).toContain("会话已清除。");
    instance.unmount();
  });
});
