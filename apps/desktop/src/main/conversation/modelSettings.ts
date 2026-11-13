import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  CLIENT_CONFIG_VERSION,
  type ClientConfig,
  defaultClientConfig,
  type LocalModelConfig,
  parseClientConfig,
  readClientConfig,
  writeClientConfig,
} from "@answra/config";
import type {
  ConversationModelSettings,
  ConversationModelSettingsView,
  ConversationModelSource,
} from "@answra/shared";
import { ModelSecretStore } from "./modelSecret";

/**
 * 模型来源设置：非 secret 字段写共享 `Answra/config.json`，API Key 只写
 * `userData/conversation-model-key.json` 的 safeStorage 密文。
 *
 * CLI 读取同一份共享文件；密钥不共享，CLI 使用自己的环境变量或参数。
 */

export const MODEL_SETTINGS_FILE = "conversation-model.json";
export const MODEL_SECRET_FILE = "conversation-model-key.json";

/** 内存里的合并视图：共享配置 + 仅桌面可解的密钥。 */
export interface StoredModelSettings {
  source: ConversationModelSource;
  baseUrl: string;
  model: string;
  answerModel?: string;
  encryptedKey?: string;
}

export interface ModelSettingsStorePaths {
  readonly configPath: string;
  readonly legacyPath: string;
  readonly secretPath: string;
}

export function defaultModelSettings(): StoredModelSettings {
  return { source: "cloud", baseUrl: "", model: "" };
}

/** 校验并归一化渲染层提交的设置；不合法直接抛错，由 IPC 层转成用户可见文案。 */
export function validateModelSettings(input: unknown): ConversationModelSettings {
  if (typeof input !== "object" || input === null) throw new Error("模型设置无效");
  const record = input as Record<string, unknown>;
  const source: ConversationModelSource =
    record.source === "local" || record.source === "cloud" ? record.source : "cloud";
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const answerModelRaw =
    typeof record.answerModel === "string" ? record.answerModel.trim() : undefined;
  const apiKeyRaw = typeof record.apiKey === "string" ? record.apiKey.trim() : undefined;
  if (source === "local") {
    if (!baseUrl) throw new Error("请填写本地模型地址");
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error("本地模型地址需以 http(s):// 开头");
    if (baseUrl.includes("@")) throw new Error("本地模型地址不能包含账号密码");
    if (!model) throw new Error("请填写模型 ID");
  }
  return {
    source,
    baseUrl,
    model,
    answerModel: answerModelRaw ? answerModelRaw : undefined,
    apiKey: apiKeyRaw ? apiKeyRaw : undefined,
  };
}

/** 渲染层摘要：打包版强制云端，本地来源只在开发态出现。 */
export function toView(
  settings: StoredModelSettings,
  localAvailable: boolean,
): ConversationModelSettingsView {
  const source: ConversationModelSource =
    localAvailable && settings.source === "local" ? "local" : "cloud";
  return {
    source,
    localAvailable,
    baseUrl: settings.baseUrl,
    model: settings.model,
    answerModel: settings.answerModel ?? "",
    configured: Boolean(settings.baseUrl && settings.model),
  };
}

export class ModelSettingsStore {
  private current: StoredModelSettings = defaultModelSettings();
  private ready?: Promise<void>;
  private readonly secret: ModelSecretStore;

  constructor(private readonly paths: ModelSettingsStorePaths) {
    this.secret = new ModelSecretStore(paths.secretPath);
  }

  /**
   * 首次调用时读盘。`safeStorage.isEncryptionAvailable()` 只有 app ready 之后才为真：
   * 若在构造期（模块加载时）读盘会误判为不可用而直接返回默认值，导致已保存配置
   * 每次重启都「消失」，故把读盘延迟到 init。
   */
  init(): Promise<void> {
    if (!this.ready) this.ready = this.load();
    return this.ready;
  }

  read(): StoredModelSettings {
    return this.current;
  }

  async save(settings: ConversationModelSettings): Promise<void> {
    await this.init();
    const local = this.resolveLocal(settings);
    const config: ClientConfig = {
      version: CLIENT_CONFIG_VERSION,
      model: { source: settings.source, local },
    };
    await writeClientConfig(this.paths.configPath, config);
    await this.secret.save(settings.source === "local" ? settings.apiKey : undefined);
    this.current = storedSettings(config, this.secret.encryptedKey());
  }

  async clear(): Promise<void> {
    await this.init();
    await Promise.all([
      rm(this.paths.configPath, { force: true }),
      rm(this.paths.legacyPath, { force: true }),
      this.secret.remove(),
    ]);
    this.current = defaultModelSettings();
  }

  /** 仅在渲染层点开明文时调用；无 Key 时返回 null。 */
  async revealApiKey(): Promise<string | null> {
    await this.init();
    return this.secret.reveal();
  }

  private resolveLocal(settings: ConversationModelSettings): LocalModelConfig {
    const baseUrl = settings.baseUrl.replace(/\/+$/, "");
    const chatModel = settings.model;
    const answerModel = settings.answerModel ?? this.current.answerModel;
    if (baseUrl || chatModel) {
      return {
        baseUrl,
        chatModel,
        ...(answerModel ? { answerModel } : {}),
      };
    }
    return {
      baseUrl: this.current.baseUrl,
      chatModel: this.current.model,
      ...(answerModel ? { answerModel } : {}),
    };
  }

  private async load(): Promise<void> {
    await this.secret.init();
    const shared = await readClientConfig(this.paths.configPath).catch((error: unknown) => {
      console.warn("[model-settings] 共享配置无法读取，按默认云端处理", error);
      return null;
    });
    const legacy = await this.readLegacy();
    const config = await this.migrateLegacy(shared, legacy);
    this.current = storedSettings(config, this.secret.encryptedKey());
  }

  private async migrateLegacy(
    shared: ClientConfig | null,
    legacy: StoredModelSettings | null,
  ): Promise<ClientConfig> {
    if (legacy === null) return shared ?? defaultClientConfig();
    let config = shared;
    let configReady = shared !== null;
    let secretReady = this.secret.encryptedKey() !== undefined || legacy.encryptedKey === undefined;
    if (config === null) {
      try {
        config = parseClientConfig(legacyConfig(legacy));
        await writeClientConfig(this.paths.configPath, config);
        configReady = true;
      } catch (error) {
        console.warn("[model-settings] 旧配置迁移失败，保留旧文件", error);
      }
    }
    if (legacy.encryptedKey !== undefined && this.secret.encryptedKey() === undefined) {
      try {
        await this.secret.importEncryptedKey(legacy.encryptedKey);
        secretReady = true;
      } catch (error) {
        console.warn("[model-settings] 旧 API Key 迁移失败，保留旧文件", error);
      }
    }
    if (configReady && secretReady) {
      await rm(this.paths.legacyPath, { force: true }).catch((error: unknown) => {
        console.warn("[model-settings] 旧配置文件删除失败", error);
      });
    }
    return config ?? defaultClientConfig();
  }

  private async readLegacy(): Promise<StoredModelSettings | null> {
    let raw: string;
    try {
      raw = await readFile(this.paths.legacyPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      console.warn("[model-settings] 旧配置无法读取", error);
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredModelSettings>;
      return {
        source: parsed.source === "local" ? "local" : "cloud",
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
        model: typeof parsed.model === "string" ? parsed.model : "",
        ...(typeof parsed.answerModel === "string" ? { answerModel: parsed.answerModel } : {}),
        ...(typeof parsed.encryptedKey === "string" ? { encryptedKey: parsed.encryptedKey } : {}),
      };
    } catch (error) {
      console.warn("[model-settings] 旧配置文件无法解析", error);
      return null;
    }
  }
}

function legacyConfig(settings: StoredModelSettings): ClientConfig {
  return {
    version: CLIENT_CONFIG_VERSION,
    model: {
      source: settings.source,
      local: {
        baseUrl: settings.baseUrl,
        chatModel: settings.model,
        ...(settings.answerModel ? { answerModel: settings.answerModel } : {}),
      },
    },
  };
}

function storedSettings(
  config: ClientConfig,
  encryptedKey: string | undefined,
): StoredModelSettings {
  return {
    source: config.model.source,
    baseUrl: config.model.local.baseUrl,
    model: config.model.local.chatModel,
    ...(config.model.local.answerModel ? { answerModel: config.model.local.answerModel } : {}),
    ...(encryptedKey ? { encryptedKey } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

export function modelSettingsFilePath(configDir: string): string {
  return path.join(configDir, MODEL_SETTINGS_FILE);
}

export function modelSettingsSecretPath(configDir: string): string {
  return path.join(configDir, MODEL_SECRET_FILE);
}
