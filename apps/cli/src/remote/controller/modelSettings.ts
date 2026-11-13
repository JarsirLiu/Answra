/** 用 host 的模型设置驱动现有 TUI `/model`，不在 controller 本地读写配置。 */
import type { LocalModelConfig } from "@answra/config";
import type { HostModelSettingsPort } from "@answra/remote";
import type { ConversationModelConfig } from "@answra/shared";
import type { RemoteModelSettingsView } from "@answra/shared/schema";
import type {
  LocalModelInput,
  ModelOverrides,
  ModelSettings,
  ModelSettingsSnapshot,
} from "../../model/ports";

export function createRemoteModelSettings(settings: HostModelSettingsPort): ModelSettings {
  return {
    async resolve(_overrides: readonly ModelOverrides[]) {
      return toConversationModelConfig(await settings.snapshot());
    },
    async snapshot() {
      return toSnapshot(await settings.snapshot());
    },
    async addLocal(input: LocalModelInput) {
      return toConversationModelConfig(await settings.addLocal(input));
    },
    async switchChatModel(chatModel: string) {
      return toConversationModelConfig(await settings.switchChatModel(chatModel));
    },
    async clearLocal() {
      await settings.clearLocal();
    },
  };
}

function toSnapshot(view: RemoteModelSettingsView): ModelSettingsSnapshot {
  return {
    source: view.source,
    local: toLocalModel(view),
    configured: view.configured,
  };
}

function toLocalModel(view: RemoteModelSettingsView): LocalModelConfig {
  return {
    baseUrl: view.baseUrl,
    chatModel: view.chatModel,
    ...(view.answerModel === undefined ? {} : { answerModel: view.answerModel }),
  };
}

function toConversationModelConfig(view: RemoteModelSettingsView): ConversationModelConfig {
  const auth = view.source;
  return {
    chat: {
      baseUrl: view.baseUrl,
      model: view.chatModel,
      auth,
    },
    answer: {
      baseUrl: view.baseUrl,
      model: view.answerModel ?? view.chatModel,
      auth,
    },
  };
}
