import type { ConversationCapabilityEndpoint } from "@answra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextSdk, streamTextSdk } = vi.hoisted(() => ({
  generateTextSdk: vi.fn(async () => ({ text: "ok" })),
  streamTextSdk: vi.fn(() => ({ fullStream: [] })),
}));

vi.mock("ai", () => ({
  generateText: generateTextSdk,
  streamText: streamTextSdk,
}));

import { generateModelText, streamModel } from "../../../src/core/model/modelTransport";

const endpoint: ConversationCapabilityEndpoint = {
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
  model: "deepseek-v4.1-flash",
  auth: "local",
  headers: { "User-Agent": "answra-cli/0.1.0" },
  sessionHeader: "x-opencode-session",
};

const transport = {
  endpoint,
  accessToken: "key-1",
  conversationId: "conversation-1",
};

beforeEach(() => {
  generateTextSdk.mockClear();
  streamTextSdk.mockClear();
});

describe("modelTransport", () => {
  it("passes provider headers and the conversation session to streamText", () => {
    streamModel({
      transport,
      options: { prompt: "hi" },
      signal: new AbortController().signal,
    });

    expect(streamTextSdk).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { "x-opencode-session": "conversation-1" },
        maxRetries: 0,
      }),
    );
  });

  it("passes the conversation session to generateText", async () => {
    await generateModelText({ transport, prompt: "hi" });

    expect(generateTextSdk).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { "x-opencode-session": "conversation-1" },
        maxRetries: 0,
      }),
    );
  });
});
