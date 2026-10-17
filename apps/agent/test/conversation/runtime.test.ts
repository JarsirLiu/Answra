import { createServer, type Server } from "node:http";
import type { ConversationChange } from "@answra/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationRuntime } from "../../src/conversation/runtime";

describe("ephemeral conversation runtime", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  let runtime: ConversationRuntime;
  let changes: ConversationChange[];
  let holdResponse: boolean;

  beforeEach(async () => {
    requests = [];
    changes = [];
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
    runtime = new ConversationRuntime((change) => changes.push(change));
    runtime.configure({ baseUrl, model: "vision-test" });
  });

  afterEach(async () => {
    runtime?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("keeps every send independent and transmits the image as part of only that request", async () => {
    const first = await runtime.send("test-conversation", {
      text: "解释截图 A",
      images: [{ name: "capture.png", dataUrl: "data:image/png;base64,QUJD" }],
    });
    await waitForTerminal(first.runId);
    const second = await runtime.send("test-conversation", { text: "只看问题 B", images: [] });
    await waitForTerminal(second.runId);

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain("解释截图 A");
    expect(JSON.stringify(requests[0]?.messages)).toContain("image_url");
    expect(JSON.stringify(requests[1]?.messages)).toContain("只看问题 B");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("解释截图 A");
    expect(runtime.activeRunCount).toBe(0);
    const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
    const revisions = changes.map((change) =>
      change.type === "event"
        ? change.event.revision
        : change.type === "snapshot"
          ? change.snapshot.revision
          : change.revision,
    );
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    const snapshot = await runtime.getSnapshot("test-conversation");
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(snapshot.messages[1]).toMatchObject({ text: "收到", status: "complete" });
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
      runtime.send("test-conversation", {
        text: "",
        images: [{ name: "bad.svg", dataUrl: "data:image/svg+xml;base64,QUJD" }],
      }),
    ).rejects.toThrow("图片格式");
    await expect(
      runtime.send("test-conversation", {
        text: "",
        images: [{ name: "bad.png", dataUrl: `data:image/png;base64,${"A".repeat(11_200_000)}` }],
      }),
    ).rejects.toThrow("8 MB");
    expect(runtime.activeRunCount).toBe(0);
    expect(changes.filter((change) => change.type === "event")).toHaveLength(0);
  });

  it("aborts an active request and releases its temporary run state", async () => {
    holdResponse = true;
    const { runId } = await runtime.send("test-conversation", { text: "请取消", images: [] });
    runtime.cancel(runId);
    await waitForTerminal(runId);

    expect(
      changes.some(
        (change) =>
          change.type === "event" &&
          change.event.runId === runId &&
          change.event.chunk.type === "abort",
      ),
    ).toBe(true);
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

    const { runId } = await runtime.send("test-conversation", { text: "hello", images: [] });
    await waitForTerminal(runId);

    const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
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
        changes.some(
          (event) =>
            (event.type === "event" &&
              event.event.runId === runId &&
              event.event.chunk.type === "finish") ||
            (event.type === "event" && event.event.chunk.type === "abort"),
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run timed out: ${runId}`);
  }
});
