import { describe, expect, it, vi } from "vitest";
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

  it("returns model-visible failure content instead of throwing for business failures", async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool<string, string>({
        id: toolId("test.fail"),
        metadata: { ...BASE_METADATA, name: "Fail" },
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => ({
          ok: false as const,
          code: "handler-failed" as const,
          message: "nope",
        }),
      }),
    );

    const execute = registry.authorize([toolId("test.fail")], sessionContext()).Fail?.execute;
    if (!execute) throw new Error("test tool must be executable");

    await expect(execute({}, { toolCallId: "call-1", messages: [] })).resolves.toBe(
      "工具调用失败（handler-failed）：nope",
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

  it("passes the session worker path and combines it with the SDK abort signal", async () => {
    const registry = new ToolRegistry({ workerPaths: { grep: "registry-worker" } });
    registry.register(
      defineTool<string, string>({
        id: toolId("test.worker"),
        metadata: { ...BASE_METADATA, name: "Worker" },
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_input, context) => context.workerPaths?.grep ?? "none",
      }),
    );
    const execute = registry.authorize([toolId("test.worker")], sessionContext()).Worker?.execute;
    if (!execute) throw new Error("test tool must be executable");
    const overridden = registry.authorize([toolId("test.worker")], {
      ...sessionContext(),
      workerPaths: { grep: "session-worker" },
    }).Worker?.execute;
    if (!overridden) throw new Error("test tool must be executable");

    await expect(execute({}, { toolCallId: "call-1", messages: [] })).resolves.toBe(
      "registry-worker",
    );
    await expect(overridden({}, { toolCallId: "call-1", messages: [] })).resolves.toBe(
      "session-worker",
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      execute({}, { toolCallId: "call-1", messages: [], abortSignal: controller.signal }),
    ).resolves.toBe("工具调用失败（aborted）：工具调用已取消");
  });

  it("disposes registered tool resources and clears the registry", async () => {
    const dispose = vi.fn();
    const registry = new ToolRegistry();
    registry.register(
      defineTool<string, string>({
        ...testTool("test.dispose", "Dispose"),
        dispose,
      }),
    );

    await registry.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
    expect(() => registry.require(toolId("test.dispose"))).toThrow("工具未注册");
  });
});
