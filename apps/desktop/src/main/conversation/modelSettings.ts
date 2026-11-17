import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  CLIENT_CONFIG_VERSION,
  type ClientConfig,
  defaultClientConfig,
  type LocalModelConfig,
  mergeLocalModel,
  parseClientConfig,
  readClientConfig,
  writeClientConfig,
} from "@answra/config";
import { createSystemModelCredentialStore, type ModelCredentialStore } from "@answra/credentials";
import type {
  ConversationModelSettings,
  ConversationModelSettingsView,
  ConversationModelSource,
} from "@answra/shared";
import { decryptLegacyApiKey, ModelSecretStore } from "./modelSecret";

/**
 * 模型来源设置：非 secret 字段写共享 `Answra/config.json`，API Key 写 OS keychain。
 *
 * 旧版 `userData/conversation-model-key.json` 与 `conversation-model.json.encryptedKey`
 * 只在启动时迁移；迁移成功即删除旧文件。
 */

export const MODEL_SETTINGS_FILE = "conversation-model.json";
export const MODEL_SECRET_FILE = "conversation-model-key.json";

/** 内存里的合并视图：共享配置；API Key 不进入这个结构。 */
export interface StoredModelSettings {
  source: ConversationModelSource;
  baseUrl: string;
  model: string;
  answerModel?: string;
}

interface LegacyStoredModelSettings extends StoredModelSettings {
  encryptedKey?: string;
}

export interface ModelSettingsStorePaths {
  readonly configPath: string;
  readonly legacyPath: string;
  /** 旧版 safeStorage 密文路径；迁移完成后删除。 */
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

/** 渲染层摘要：full 打包版强制云端；开发态与 answer 打包版保留本地来源。 */
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
  private readonly legacySecret: ModelSecretStore;

  constructor(
    private readonly paths: ModelSettingsStorePaths,
    private readonly secret: ModelCredentialStore = createSystemModelCredentialStore(),
  ) {
    this.legacySecret = new ModelSecretStore(paths.secretPath);
  }

  /**
   * 首次调用时读盘。读盘依赖 app ready 后的 safeStorage 迁移能力，
   * 因此把读盘延迟到 init，避免模块加载时误判为不可用。
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
    if (settings.source === "cloud") {
      await this.secret.clear();
    } else if (settings.apiKey) {
      await this.secret.write(settings.apiKey);
    }
    await writeClientConfig(this.paths.configPath, config);
    this.current = storedSettings(config);
  }

  async clear(): Promise<void> {
    await this.init();
    await this.secret.clear();
    await Promise.all([
      rm(this.paths.configPath, { force: true }),
      rm(this.paths.legacyPath, { force: true }),
      this.legacySecret.remove(),
    ]);
    this.current = defaultModelSettings();
  }

  /** 仅在渲染层点开明文时调用；没有 Key 时返回 null。 */
  async revealApiKey(): Promise<string | null> {
    await this.init();
    return this.secret.read();
  }

  private resolveLocal(settings: ConversationModelSettings): LocalModelConfig {
    return mergeLocalModel(
      {
        baseUrl: this.current.baseUrl,
        chatModel: this.current.model,
        ...(this.current.answerModel ? { answerModel: this.current.answerModel } : {}),
      },
      {
        baseUrl: settings.baseUrl,
        chatModel: settings.model,
        ...(settings.answerModel === undefined ? {} : { answerModel: settings.answerModel }),
      },
    );
  }

  private async load(): Promise<void> {
    const shared = await readClientConfig(this.paths.configPath).catch((error: unknown) => {
      console.warn("[model-settings] 共享配置无法读取，按默认云端处理", error);
      return null;
    });
    const legacy = await this.readLegacy();
    const config = await this.migrateLegacy(shared, legacy);
    this.current = storedSettings(config);
  }

  private async migrateLegacy(
    shared: ClientConfig | null,
    legacy: LegacyStoredModelSettings | null,
  ): Promise<ClientConfig> {
    let config = shared;
    let configReady = shared !== null;
    if (config === null && legacy !== null) {
      try {
        config = parseClientConfig(legacyConfig(legacy));
        await writeClientConfig(this.paths.configPath, config);
        configReady = true;
      } catch (error) {
        console.warn("[model-settings] 旧配置迁移失败，保留旧文件", error);
      }
    }

    let secretReady = true;
    let legacyKey: string | null = null;
    try {
      legacyKey = await this.readLegacyApiKey(legacy);
    } catch (error) {
      secretReady = false;
      console.warn("[model-settings] 旧 API Key 迁移失败，保留旧文件", error);
    }
    if (legacyKey !== null && secretReady) {
      try {
        const existing = await this.secret.read();
        if (existing === null) await this.secret.write(legacyKey);
      } catch (error) {
        secretReady = false;
        console.warn("[model-settings] 旧 API Key 写入系统凭据库失败，保留旧文件", error);
      }
    }

    if (configReady && secretReady) {
      await Promise.all([
        rm(this.paths.legacyPath, { force: true }),
        this.legacySecret.remove(),
      ]).catch((error: unknown) => {
        console.warn("[model-settings] 旧配置文件删除失败", error);
      });
    }
    return config ?? defaultClientConfig();
  }

  private async readLegacyApiKey(legacy: LegacyStoredModelSettings | null): Promise<string | null> {
    await this.legacySecret.init();
    const fromSecretFile = await this.legacySecret.reveal();
    if (fromSecretFile !== null) return fromSecretFile;
    return legacy?.encryptedKey ? decryptLegacyApiKey(legacy.encryptedKey) : null;
  }

  private async readLegacy(): Promise<LegacyStoredModelSettings | null> {
    let raw: string;
    try {
      raw = await readFile(this.paths.legacyPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      console.warn("[model-settings] 旧配置无法读取", error);
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LegacyStoredModelSettings>;
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

function storedSettings(config: ClientConfig): StoredModelSettings {
  return {
    source: config.model.source,
    baseUrl: config.model.local.baseUrl,
    model: config.model.local.chatModel,
    ...(config.model.local.answerModel ? { answerModel: config.model.local.answerModel } : {}),
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
