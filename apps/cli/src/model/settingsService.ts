/** CLI 模型设置应用服务：实现 ModelSettings 端口，只组合共享纯函数与文件端口。 */
import { type ClientConfig, defaultClientConfig, normalizeLocalModel } from "@answra/config";
import type { ConversationModelConfig } from "@answra/shared";
import type {
  LocalModelInput,
  ModelOverrides,
  ModelSettings,
  ModelSettingsSnapshot,
  ModelSettingsStore,
} from "./ports";
import { resolveLocalModel } from "./precedence";
import { selectChatModel, selectLocalModel } from "./selection";

export class ModelSettingsService implements ModelSettings {
  constructor(private readonly store: ModelSettingsStore) {}

  async resolve(overrides: readonly ModelOverrides[]): Promise<ConversationModelConfig> {
    const config = await this.load();
    return resolveLocalModel(overrides, config.model.local);
  }

  async snapshot(): Promise<ModelSettingsSnapshot> {
    const config = await this.load();
    return {
      source: config.model.source,
      local: config.model.local,
      configured: isConfigured(config),
    };
  }

  async addLocal(input: LocalModelInput): Promise<ConversationModelConfig> {
    const config = await this.load();
    const local = selectLocalModel(input);
    await this.store.write({
      version: config.version,
      model: { source: "local", local },
    });
    return resolveLocalModel([], local);
  }

  async switchChatModel(chatModel: string): Promise<ConversationModelConfig> {
    const config = await this.load();
    if (!isConfigured(config)) throw new Error("尚未配置本地模型，请先运行 `answra config set`。");
    const local = normalizeLocalModel({
      baseUrl: config.model.local.baseUrl,
      chatModel: selectChatModel(chatModel),
      ...(config.model.local.answerModel ? { answerModel: config.model.local.answerModel } : {}),
    });
    await this.store.write({
      version: config.version,
      model: { source: "local", local },
    });
    return resolveLocalModel([], local);
  }

  async clearLocal(): Promise<void> {
    const config = await this.load();
    await this.store.write({
      version: config.version,
      model: { source: "cloud", local: { baseUrl: "", chatModel: "" } },
    });
  }

  private async load(): Promise<ClientConfig> {
    return (await this.store.read()) ?? defaultClientConfig();
  }
}

function isConfigured(config: ClientConfig): boolean {
  return Boolean(config.model.local.baseUrl && config.model.local.chatModel);
}
