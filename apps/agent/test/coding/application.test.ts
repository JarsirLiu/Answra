import { createServer, type Server } from "node:http";
import { CODING_AGENT_ID, type CodingHost, startCodingHost } from "@answra/agent/composition";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type RecordedRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
  authorization?: string;
};

const ACCESS_TOKEN = "coding-access-token";

function endpoint(port: number) {
  return { baseUrl: `http://127.0.0.1:${port}/v1`, model: "text.chat" };
}

function streamBody(text: string): string {
  return [
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "分析中", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

describe("CLI coding host", () => {
  let server: Server;
  let requests: RecordedRequest[];
  let events: AgentEventEnvelope[];
  let host: CodingHost;
  let holdResponse = false;

  beforeEach(async () => {
    requests = [];
    events = [];
    holdResponse = false;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: unknown;
      };
      requests.push({
        messages: parsed.messages ?? [],
        tools: parsed.tools,
        authorization: request.headers.authorization,
      });
      if (holdResponse) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(streamBody("已读取"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    host = startCodingHost({
      emitEvent: (event) => events.push(event),
      workspaceRoot: "D:/coding-workspace",
    });
    host.runtime.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });
  });

  afterEach(async () => {
    host?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("runs the dedicated coding bot with its own prompt, tools, and snapshot", async () => {
    const created = await host.runtime.createConversation("coding-session");
    expect(created.activeAgentId).toBe(CODING_AGENT_ID);
    expect(created.participantAgentIds).toEqual([CODING_AGENT_ID]);

    const { runId, snapshot } = await host.runtime.send(
      "coding-session",
      { text: "读取 README 并概述结构", images: [] },
      ACCESS_TOKEN,
    );
    expect(snapshot.activeRunId).toBe(runId);
    await host.runtime.waitForRun(runId);

    const final = await host.runtime.getSnapshot("coding-session");
    expect(final.messages.map((message) => [message.role, message.text, message.status])).toEqual([
      ["user", "读取 README 并概述结构", "complete"],
      ["assistant", "已读取", "complete"],
    ]);
    expect(final.activeRunId).toBeUndefined();

    const body = JSON.stringify(requests.at(-1));
    expect(body).toContain("命令行编码助手");
    expect(body).toContain("当前工作目录：D:/coding-workspace");
    expect(body).toContain("Read");
    expect(body).toContain("Grep");
    expect(body).toContain("Edit");
    expect(body).toContain("RunCommand");
    expect(body).toContain("WriteStdin");
    expect(body).not.toContain("通用 AI 助手");
    expect(requests.at(-1)?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(events.some((event) => event.runId === runId && event.event.type === "text-delta")).toBe(
      true,
    );
  });

  it("rejects image input before starting a run", async () => {
    await host.runtime.createConversation("coding-images");

    await expect(
      host.runtime.send(
        "coding-images",
        {
          text: "看这张图",
          images: [{ name: "capture.png", dataUrl: "data:image/png;base64,QUJD" }],
        },
        ACCESS_TOKEN,
      ),
    ).rejects.toThrow("暂不支持图片输入");

    expect(host.runtime.activeRunCount).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("cancels an active coding run", async () => {
    holdResponse = true;
    await host.runtime.createConversation("coding-cancel");
    const { runId } = await host.runtime.send(
      "coding-cancel",
      { text: "运行一个长任务", images: [] },
      ACCESS_TOKEN,
    );

    host.runtime.cancel(runId);

    await expect
      .poll(
        () =>
          events.some(
            (event) =>
              event.runId === runId &&
              event.event.type === "run-state-changed" &&
              event.event.state === "aborted",
          ),
        { timeout: 5_000, interval: 10 },
      )
      .toBe(true);
    await expect.poll(() => host.runtime.activeRunCount, { timeout: 5_000, interval: 10 }).toBe(0);

    const final = await host.runtime.getSnapshot("coding-cancel");
    expect(final.messages.at(-1)?.status).toBe("interrupted");
  });
});
