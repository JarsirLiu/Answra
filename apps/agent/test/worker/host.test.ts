import { createServer, type Server } from "node:http";
import type { AgentCommand, AgentFrame, AgentTransport } from "@answra/agent";
import { startAgentHost } from "@answra/agent";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    tokenRequests: () => frames.filter((frame) => frame.type === "token-request"),
  };
}

describe("agent worker host", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function startUnauthorizedServer(): Promise<string> {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "unauthorized", type: "authentication_error", code: "unauthorized" },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    return `http://127.0.0.1:${address.port}/v1`;
  }

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
      accessToken: "test-token",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));

    expect(harness.responses()[0]).toMatchObject({
      id: "1",
      ok: false,
      error: "云端模型服务尚未就绪",
    });
  });

  it("asks the host for a fresh token on 401 and answers its own reverse request", async () => {
    const baseUrl = await startUnauthorizedServer();
    const harness = createHarness();
    const host = startAgentHost({ transport: harness.transport });
    host.runtime.configure({
      chat: { baseUrl, model: "text.chat" },
      answer: { baseUrl, model: "image.answer" },
    });

    harness.dispatch({
      id: "1",
      type: "chat-send",
      operation: "chat.send",
      profileId: "general-chat",
      conversationId: "c1",
      request: { text: "hi", images: [] },
      accessToken: "stale-token",
    });

    // 反向请求必须由宿主（desktop main）回答：agent 自己不持有刷新能力。
    let answered = false;
    await vi.waitFor(() => {
      const [request] = harness.tokenRequests();
      expect(request).toBeDefined();
      if (answered || request?.type !== "token-request") return;
      answered = true;
      expect(request.forceRefresh).toBe(true);
      harness.dispatch({ id: request.id, type: "token", accessToken: "fresh-token" });
    });

    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));
    expect(harness.responses()[0]).toMatchObject({ id: "1", ok: true });
  });

  it("ignores a token answer that no run is waiting for", () => {
    const harness = createHarness();
    const host = startAgentHost({ transport: harness.transport });
    const dispose = vi.spyOn(host.runtime, "dispose");

    harness.dispatch({ id: "token-request:999", type: "token", accessToken: "fresh-token" });

    expect(harness.responses()).toHaveLength(0);
    expect(dispose).not.toHaveBeenCalled();
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
