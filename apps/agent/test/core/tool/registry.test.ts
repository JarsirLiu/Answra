import { describe, expect, it } from "vitest";
import {
  defineTool,
  type ToolEntry,
  type ToolMetadata,
  ToolRegistry,
  type ToolSessionContext,
  toolId,
} from "../../../src/core/tool";

const BASE_METADATA: ToolMetadata = {
  name: "Test",
  description: "test tool",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  sideEffectScope: "none",
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
  resultBudget: { strategy: "inline", maxModelChars: 1_024 },
};

function testTool(id: string, name: string): ToolEntry<string, string> {
  return defineTool<string, string>({
    id: toolId(id),
    metadata: { ...BASE_METADATA, name },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => "ok",
  });
}

function sessionContext(): ToolSessionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: null,
    runId: "run-1",
    sessionId: "session-1",
  };
}

describe("tool registry", () => {
  it("registers definitions once and rejects duplicate ids", () => {
    const registry = new ToolRegistry();
    registry.register(testTool("test.one", "One"));

    expect(() => registry.register(testTool("test.one", "Other"))).toThrow("工具已注册：test.one");
  });

  it("authorizes only requested ids and fails closed for unregistered ids", () => {
    const registry = new ToolRegistry();
    registry.register(testTool("test.one", "One"));
    registry.register(testTool("test.two", "Two"));

    expect(Object.keys(registry.authorize([toolId("test.two")], sessionContext()))).toEqual([
      "Two",
    ]);
    expect(() => registry.authorize([toolId("test.missing")], sessionContext())).toThrow(
      "工具未注册：test.missing",
    );
  });

  it("rejects two authorized tools that share the same model name", () => {
    const registry = new ToolRegistry();
    registry.register(testTool("test.one", "Same"));
    registry.register(testTool("test.two", "Same"));

    expect(() =>
      registry.authorize([toolId("test.one"), toolId("test.two")], sessionContext()),
    ).toThrow("工具名重复：Same");
  });
});
