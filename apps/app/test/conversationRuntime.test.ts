import { createServer, type Server } from "node:http";
import type { ConversationEvent } from "@answra/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationRuntime } from "../src/conversationRuntime";

describe("ephemeral conversation runtime", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  let runtime: ConversationRuntime;
  let events: ConversationEvent[];
  let holdResponse: boolean;

  beforeEach(async () => {
    requests = [];
    events = [];
    holdResponse = false;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof requests)[number],
      );
      if (holdResponse) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "vision-test", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "分析中", content: "收到" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "vision-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime = new ConversationRuntime((event) => events.push(event));
    runtime.configure({ baseUrl, model: "vision-test" });
  });

  afterEach(async () => {
    runtime?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("keeps every send independent and transmits the image as part of only that request", async () => {
    const first = await runtime.send({
      text: "解释截图 A",
      images: [{ name: "capture.png", dataUrl: "data:image/png;base64,QUJD" }],
    });
    await waitForTerminal(first.runId);
    const second = await runtime.send({ text: "只看问题 B", images: [] });
    await waitForTerminal(second.runId);

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain("解释截图 A");
    expect(JSON.stringify(requests[0]?.messages)).toContain("image_url");
    expect(JSON.stringify(requests[1]?.messages)).toContain("只看问题 B");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("解释截图 A");
    expect(runtime.activeRunCount).toBe(0);
    expect(events.filter((event) => event.chunk.type === "finish")).toHaveLength(2);
    expect(
      events.some(
        (event) => event.chunk.type === "reasoning-delta" && event.chunk.delta === "分析中",
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.chunk.type === "text-delta" && event.chunk.delta === "收到"),
    ).toBe(true);
  });

  it("rejects unsupported or oversized images without starting a run", async () => {
    await expect(
      runtime.send({
        text: "",
        images: [{ name: "bad.svg", dataUrl: "data:image/svg+xml;base64,QUJD" }],
      }),
    ).rejects.toThrow("图片格式");
    await expect(
      runtime.send({
        text: "",
        images: [{ name: "bad.png", dataUrl: `data:image/png;base64,${"A".repeat(11_200_000)}` }],
      }),
    ).rejects.toThrow("8 MB");
    expect(runtime.activeRunCount).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("aborts an active request and releases its temporary run state", async () => {
    holdResponse = true;
    const { runId } = await runtime.send({ text: "请取消", images: [] });
    runtime.cancel(runId);
    await waitForTerminal(runId);

    expect(events).toContainEqual({
      runId,
      chunk: expect.objectContaining({ type: "abort" }),
    });
    expect(runtime.activeRunCount).toBe(0);
  });

  it("emits a visible error and terminal chunk when the model endpoint rejects the request", async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    runtime.configure({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "vision-test" });

    const { runId } = await runtime.send({ text: "hello", images: [] });
    await waitForTerminal(runId);

    expect(events.some((event) => event.runId === runId && event.chunk.type === "error")).toBe(
      true,
    );
    expect(events.some((event) => event.runId === runId && event.chunk.type === "finish")).toBe(
      true,
    );
    expect(runtime.activeRunCount).toBe(0);
  });

  async function waitForTerminal(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (
        events.some(
          (event) =>
            (event.runId === runId && event.chunk.type === "finish") ||
            event.chunk.type === "abort",
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run timed out: ${runId}`);
  }
});
