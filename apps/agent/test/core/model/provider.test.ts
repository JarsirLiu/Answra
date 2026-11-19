import type { ConversationCapabilityEndpoint } from "@answra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAICompatible } = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn(() => "provider"),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));

import { createModelProvider } from "../../../src/core/model/provider";

const endpoint: ConversationCapabilityEndpoint = {
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
  model: "deepseek-v4.1-flash",
  auth: "local",
};

beforeEach(() => {
  createOpenAICompatible.mockClear();
});

describe("createModelProvider", () => {
  it("passes provider-level headers through AI SDK options", () => {
    createModelProvider({
      endpoint,
      accessToken: "key-1",
      headers: { "User-Agent": "answra-cli/0.1.0" },
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: endpoint.baseUrl,
        apiKey: "key-1",
        includeUsage: true,
        headers: { "User-Agent": "answra-cli/0.1.0" },
      }),
    );
  });

  it("does not add headers when the endpoint declares none", () => {
    createModelProvider({ endpoint, accessToken: "key-1" });

    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.not.objectContaining({ headers: expect.anything() }),
    );
  });
});
