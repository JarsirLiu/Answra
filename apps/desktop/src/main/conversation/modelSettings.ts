import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConversationModelSettings,
  ConversationModelSettingsView,
  ConversationModelSource,
} from "@answra/shared";
import { safeStorage } from "electron";

/**
 * 模型来源设置：`userData/conversation-model.json`，AES + OS 密钥链加密。
 *
 * 与登录凭据（`desktop-auth.bin`）同一模式：只在 `safeStorage` 可用时落盘，
 * 不可用（如 Linux 无 keyring）时**拒绝写入**，避免明文 Key 留在磁盘上。
 * `safeStorage` 仅在 app ready 之后可用。
 */

export const MODEL_SETTINGS_FILE = "conversation-model.json";

/** 落盘形状：`apiKey` 只存 `safeStorage` 加密后的 base64，绝不存明文。 */
export interface StoredModelSettings {
  source: ConversationModelSource;
  baseUrl: string;
  model: string;
  answerModel?: string;
  encryptedKey?: string;
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

  constructor(private readonly filePath: string) {}

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
    const next: StoredModelSettings = {
      source: settings.source,
      baseUrl: settings.baseUrl.replace(/\/+$/, ""),
      model: settings.model,
      answerModel: settings.answerModel,
    };
    if (settings.source === "local" && settings.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("系统安全存储不可用，未能保存 API Key");
      }
      next.encryptedKey = safeStorage.encryptString(settings.apiKey).toString("base64");
    }
    await this.persist(next);
    this.current = next;
  }

  async clear(): Promise<void> {
    await this.init();
    await rm(this.filePath, { force: true });
    this.current = defaultModelSettings();
  }

  /** 仅在渲染层点开明文时调用；无 Key 时返回 null。 */
  async revealApiKey(): Promise<string | null> {
    await this.init();
    const encrypted = this.current.encryptedKey;
    if (!encrypted) return null;
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用，无法读取 API Key");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  private async persist(settings: StoredModelSettings): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  private async load(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredModelSettings>;
      this.current = {
        ...defaultModelSettings(),
        ...parsed,
        encryptedKey: typeof parsed.encryptedKey === "string" ? parsed.encryptedKey : undefined,
      };
    } catch (error) {
      // 文件损坏（密钥轮换/手改）时按无此记录处理，不阻断启动。
      console.warn("[model-settings] 配置文件无法解析，按默认云端处理", error);
    }
  }
}

export function modelSettingsFilePath(configDir: string): string {
  return path.join(configDir, MODEL_SETTINGS_FILE);
}
