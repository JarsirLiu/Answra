/**
 * TTS 设置：非 secret 字段写共享 config.json 的 `tts` 段，Key 写独立 keychain account。
 *
 * 不合成、不播放、不判断策略；只负责归一化、单 provider 配置、能力声明与凭据读写。
 * Key 明文只经 `revealApiKey` 显式读取，`view()` 只给出 `hasApiKey`。
 */
import {
  CLIENT_CONFIG_VERSION,
  type ClientTtsConfig,
  type ClientTtsProviderConfig,
  defaultClientConfig,
  defaultClientTtsConfig,
  parseClientTtsConfig,
  readClientConfig,
} from "@answra/config";
import {
  createSystemModelCredentialStore,
  type ModelCredentialStore,
  ttsCredentialAccount,
} from "@answra/credentials";
import type {
  TtsProviderCapabilities,
  TtsProviderConfig,
  TtsProviderDraft,
  TtsSettingsPatch,
  TtsSettingsView,
} from "@answra/shared";
import { createTtsProviderPort } from "@answra/tts";
import { updateClientConfig } from "../config/clientConfigFile";

export interface TtsSettingsStoreOptions {
  readonly configPath: string;
  /** 测试注入；缺省使用系统 keychain 的 `tts-api-key:<providerId>` account。 */
  readonly createCredential?: (providerId: string) => ModelCredentialStore;
  readonly log?: (message: string, error?: unknown) => void;
}

export class TtsSettingsStore {
  private current: ClientTtsConfig = defaultClientTtsConfig();
  private readonly credentials = new Map<string, ModelCredentialStore>();
  private ready?: Promise<void>;

  constructor(private readonly options: TtsSettingsStoreOptions) {}

  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  read(): ClientTtsConfig {
    return this.current;
  }

  async view(): Promise<TtsSettingsView> {
    await this.init();
    return {
      provider: this.current.provider === null ? null : await this.viewOf(this.current.provider),
    };
  }

  /** 整体替换当前 provider；`apiKey` 留空表示沿用已保存的 Key。 */
  async save(patch: TtsSettingsPatch): Promise<TtsSettingsView> {
    await this.init();
    const base = this.current;
    const next = parseClientTtsConfig({
      provider:
        patch.provider === undefined
          ? base.provider
          : patch.provider === null
            ? null
            : storedProviderOf(patch.provider),
    });
    if (next === undefined) throw new Error("TTS 设置无效。");

    if (patch.provider !== undefined) {
      await this.syncCredential(base.provider, next.provider, patch.provider);
    }

    const written = await updateClientConfig(this.options.configPath, (existing) => ({
      version: CLIENT_CONFIG_VERSION,
      model: existing?.model ?? defaultClientConfig().model,
      ...(existing?.answer === undefined ? {} : { answer: existing.answer }),
      tts: next,
    }));
    if (written === null) throw new Error("TTS 设置写入失败。");

    this.current = next;
    return this.view();
  }

  /** 设置页显式点开明文时调用；provider 不匹配时返回 null。 */
  async revealApiKey(providerId: string): Promise<string | null> {
    await this.init();
    if (this.current.provider?.id !== providerId) return null;
    return this.readApiKey(providerId);
  }

  /** 合成服务读取 Key；keychain 不可用时抛错，由调用方转成稳定失败码。 */
  async readApiKey(providerId: string): Promise<string | null> {
    return this.credential(providerId).read();
  }

  private async viewOf(provider: ClientTtsProviderConfig): Promise<TtsProviderConfig> {
    return {
      ...provider,
      hasApiKey: await this.hasApiKey(provider.id),
      capabilities: capabilitiesOf(provider),
    };
  }

  /** 凭据库不可用时设置页仍要能打开；这里只降级为「没有已保存 Key」，不掩盖 reveal/save 的失败。 */
  private async hasApiKey(providerId: string): Promise<boolean> {
    try {
      return (await this.readApiKey(providerId)) !== null;
    } catch (error) {
      this.options.log?.("[tts-settings] 系统凭据库不可用，无法读取已保存的 Key", error);
      return false;
    }
  }

  private async syncCredential(
    previous: ClientTtsProviderConfig | null,
    next: ClientTtsProviderConfig | null,
    draft: TtsProviderDraft | null,
  ): Promise<void> {
    if (previous !== null && previous.id !== next?.id) {
      try {
        await this.credential(previous.id).clear();
      } catch (error) {
        this.options.log?.("[tts-settings] 更换 provider 时无法清理旧 Key", error);
      }
    }
    const apiKey = draft?.apiKey?.trim();
    if (next === null || apiKey === undefined || apiKey === "") return;
    await this.credential(next.id).write(apiKey);
  }

  private credential(providerId: string): ModelCredentialStore {
    const cached = this.credentials.get(providerId);
    if (cached !== undefined) return cached;
    const created =
      this.options.createCredential?.(providerId) ??
      createSystemModelCredentialStore({ account: ttsCredentialAccount(providerId) });
    this.credentials.set(providerId, created);
    return created;
  }

  private async load(): Promise<void> {
    try {
      const config = await readClientConfig(this.options.configPath);
      this.current = config?.tts ?? defaultClientTtsConfig();
    } catch (error) {
      this.options.log?.("[tts-settings] 共享配置无法读取，按未配置处理", error);
      this.current = defaultClientTtsConfig();
    }
  }
}

/** 能力声明只来自 adapter 常量；构造 port 不发起请求。 */
function capabilitiesOf(provider: ClientTtsProviderConfig): TtsProviderCapabilities {
  return createTtsProviderPort(provider.protocol, {
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: "",
    voice: provider.voice,
  }).capabilities;
}

function storedProviderOf(draft: TtsProviderDraft): ClientTtsProviderConfig {
  return {
    id: draft.id,
    label: draft.label,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    model: draft.model,
    voice: draft.voice,
  };
}
