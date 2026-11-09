import type { AgentCommand, AgentFrame, AgentTransport } from "@answra/agent";
import { startAnswerAgentHost } from "@answra/agent";
import { describe, expect, it, vi } from "vitest";

function createHarness() {
  const frames: AgentFrame[] = [];
  let listener: ((command: AgentCommand) => void) | undefined;
  const transport: AgentTransport = {
    send: (frame) => void frames.push(frame),
    onCommand: (next) => {
      listener = next;
    },
    close: vi.fn(),
  };
  return {
    transport,
    frames,
    dispatch: (command: AgentCommand) => listener?.(command),
    responses: () => frames.filter((frame) => frame.type === "response"),
    snapshots: () => frames.filter((frame) => frame.type === "conversation-snapshot"),
  };
}

describe("answer worker host", () => {
  it("returns and publishes the authoritative snapshot when clearing a conversation", async () => {
    const harness = createHarness();
    const host = startAnswerAgentHost({ transport: harness.transport });

    harness.dispatch({ id: "create", type: "create-conversation", conversationId: "answer-1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));
    harness.dispatch({ id: "clear", type: "clear-conversation", conversationId: "answer-1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(2));

    expect(harness.responses()[1]).toMatchObject({
      id: "clear",
      ok: true,
      value: { conversationId: "answer-1", eventRevision: 0, messages: [] },
    });
    expect(harness.snapshots()).toEqual([
      {
        version: 1,
        type: "conversation-snapshot",
        snapshot: { conversationId: "answer-1", eventRevision: 0, messages: [] },
      },
    ]);
    host.dispose();
  });
});
