import type { AgentCommand, AgentFrame, AgentTransport } from "@answra/agent";
import { startAgentHost } from "@answra/agent";
import { describe, expect, it, vi } from "vitest";

/** 假传输：记录上行帧、允许下行命令。证明命令分发不依赖 Electron。 */
function createHarness() {
  const frames: AgentFrame[] = [];
  const close = vi.fn();
  let listener: ((command: AgentCommand) => void) | undefined;
  const transport: AgentTransport = {
    send: (frame) => void frames.push(frame),
    onCommand: (next) => {
      listener = next;
    },
    close,
  };
  return {
    transport,
    frames,
    close,
    dispatch: (command: AgentCommand) => listener?.(command),
    responses: () => frames.filter((frame) => frame.type === "response"),
  };
}

describe("agent worker host", () => {
  it("executes commands and answers with a response frame carrying the same id", async () => {
    const harness = createHarness();
    startAgentHost({ transport: harness.transport });

    harness.dispatch({ id: "1", type: "create-conversation", conversationId: "c1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));

    harness.dispatch({ id: "2", type: "snapshot", conversationId: "c1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(2));

    const [created, snapshot] = harness.responses();
    expect(created).toMatchObject({ id: "1", ok: true });
    expect(snapshot).toMatchObject({
      id: "2",
      ok: true,
      value: { conversationId: "c1", revision: 0, messages: [] },
    });
  });

  it("reports a command failure in the response frame instead of throwing", async () => {
    const harness = createHarness();
    startAgentHost({ transport: harness.transport });

    harness.dispatch({
      id: "1",
      type: "chat-send",
      operation: "chat.send",
      profileId: "general-chat",
      conversationId: "missing",
      request: { text: "hi", images: [] },
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));

    expect(harness.responses()[0]).toMatchObject({
      id: "1",
      ok: false,
      error: "请先在设置中配置模型服务",
    });
  });

  it("disposes the runtime and closes the transport on shutdown without a response", () => {
    const harness = createHarness();
    const host = startAgentHost({ transport: harness.transport });
    const dispose = vi.spyOn(host.runtime, "dispose");

    harness.dispatch({ id: "1", type: "shutdown" });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.responses()).toHaveLength(0);
  });
});
