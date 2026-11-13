import type { ConversationModelConfig } from "@answra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings, ModelSettingsSnapshot } from "../src/model/ports";
import { createRemoteCodingHost } from "../src/remote/host/commandPort";

const MODEL: ConversationModelConfig = {
  chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
  answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
};

function createSettings(): ModelSettings {
  let snapshot: ModelSettingsSnapshot = {
    source: "local",
    local: { baseUrl: MODEL.chat.baseUrl, chatModel: MODEL.chat.model },
    configured: true,
  };
  return {
    resolve: vi.fn(async () => MODEL),
    snapshot: vi.fn(async () => snapshot),
    addLocal: vi.fn(async (input) => {
      snapshot = {
        source: "local",
        local: { baseUrl: input.baseUrl, chatModel: input.chatModel },
        configured: true,
      };
      return MODEL;
    }),
    switchChatModel: vi.fn(async (chatModel) => {
      snapshot = { ...snapshot, local: { ...snapshot.local, chatModel } };
      return MODEL;
    }),
    clearLocal: vi.fn(async () => {
      snapshot = { source: "cloud", local: { baseUrl: "", chatModel: "" }, configured: false };
    }),
  };
}

const hosts: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts.length = 0;
});

describe("remote CLI host adapter", () => {
  it("maps snapshots, settings and model application to the coding host", async () => {
    const settings = createSettings();
    const host = createRemoteCodingHost({
      workspaceRoot: process.cwd(),
      modelSettings: settings,
      accessToken: "",
    });
    hosts.push(host);

    const created = await host.port.createConversation("conversation-1");
    expect(created.conversationId).toBe("conversation-1");
    expect((await host.port.snapshot("conversation-1")).conversationId).toBe("conversation-1");

    expect(await host.port.settings().snapshot()).toMatchObject({
      chatModel: "local-model",
      configured: true,
    });
    expect(
      await host.port.settings().addLocal({
        baseUrl: "http://127.0.0.1:4321/v1",
        chatModel: "next-model",
      }),
    ).toMatchObject({ chatModel: "next-model", configured: true });

    host.port.applyModel(MODEL);
    expect(host.port.capabilities()).toEqual(["coding", "model-settings"]);
  });

  it("rejects unsupported team send before touching the coding runtime", async () => {
    const host = createRemoteCodingHost({
      workspaceRoot: process.cwd(),
      modelSettings: createSettings(),
      accessToken: "",
    });
    hosts.push(host);

    await expect(
      host.port.send({
        operation: "team.send",
        conversationId: "conversation-1",
        teamId: "team-1",
        request: { text: "hello", images: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid-command" });
  });
});
