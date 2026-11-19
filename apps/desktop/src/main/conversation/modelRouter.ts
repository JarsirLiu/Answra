import {
  authRequiredError,
  type ConversationModelConfig,
  type ConversationModelSettings,
  type ConversationModelSettingsView,
  type FeatureId,
} from "@answra/shared";
import { type StoredModelSettings, toView, validateModelSettings } from "./modelSettings";

/**
 * 模型来源的唯一裁决点：显式二选一，不做优先级兜底。
 *
 * - `local`：用本机保存的 OpenAI 兼容端点，不需要登录，Key 只在本机。
 * - `cloud`：用云端订阅下发的端点，需要登录态与访问令牌。
 *
 * 打包版是否开放本地来源由发布清单里的 `local-model` 功能位决定：
 * 未包含时本地来源在存储层就被折叠成云端，避免绕过订阅；开发态始终允许。
 */

/** 能力来自发布清单的功能位，而不是 profile 名字；开发态始终允许本地来源。 */
export function isLocalModelAvailable(isPackaged: boolean, features: readonly FeatureId[]): boolean {
  return !isPackaged || features.includes("local-model");
}

/** 设置存储端口；`ModelSettingsStore` 是主进程实现，测试用内存假件替换。 */
export interface ModelSettingsStorePort {
  init(): Promise<void>;
  read(): StoredModelSettings;
  save(settings: ConversationModelSettings): Promise<void>;
  clear(): Promise<void>;
  revealApiKey(): Promise<string | null>;
}

export interface ModelRouterDeps {
  store: ModelSettingsStorePort;
  /** 是否允许选择本地来源（开发态或 answer 打包版为 true）。 */
  localAvailable: boolean;
  cloud: {
    modelConfig(): ConversationModelConfig | null;
    hasSession(): boolean;
    accessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  };
}

export interface ResolvedModel {
  config: ConversationModelConfig;
  accessToken: string;
}

export class ModelRouter {
  constructor(private readonly deps: ModelRouterDeps) {}

  getView(): ConversationModelSettingsView {
    return toView(this.deps.store.read(), this.deps.localAvailable);
  }

  /** 保存来源与本地端点；打包版拒绝本地来源。 */
  async save(input: unknown): Promise<ConversationModelSettingsView> {
    const settings = validateModelSettings(input);
    if (settings.source === "local" && !this.deps.localAvailable) {
      throw new Error("当前版本仅支持云端订阅");
    }
    await this.deps.store.save(settings);
    return this.getView();
  }

  async clear(): Promise<ConversationModelSettingsView> {
    await this.deps.store.clear();
    return this.getView();
  }

  async revealApiKey(): Promise<string | null> {
    return this.deps.store.revealApiKey();
  }

  /** 发送门禁：本地来源直接放行（未配置时由 resolve 给出配置提示），云端仍需登录。 */
  canSend(): boolean {
    return this.getView().source === "local" || this.deps.cloud.hasSession();
  }

  /** 解析本次调用要用的端点与凭据；未登录/未配置时抛错，由渲染层呈现。 */
  async resolve(options?: { forceRefresh?: boolean }): Promise<ResolvedModel> {
    await this.deps.store.init();
    const view = this.getView();
    const answerProviderOptions = this.deps.store.read().answerProviderOptions;
    if (view.source === "local") {
      if (!view.configured) throw new Error("请先在设置 → 模型中配置本地模型服务");
      return {
        config: withAnswerProviderOptions(
          {
            chat: { baseUrl: view.baseUrl, model: view.model, auth: "local" },
            answer: { baseUrl: view.baseUrl, model: view.answerModel || view.model, auth: "local" },
          },
          answerProviderOptions,
        ),
        accessToken: (await this.deps.store.revealApiKey()) ?? "",
      };
    }
    const config = this.deps.cloud.modelConfig();
    if (!config) throw authRequiredError();
    return {
      config: withAnswerProviderOptions(config, answerProviderOptions),
      accessToken: await this.deps.cloud.accessToken(options),
    };
  }
}

/**
 * 本地 `config.json` 的答题扩展参数覆盖云端端点声明；只作用于 answer，
 * 不改 chat 或本地端点地址。
 */
function withAnswerProviderOptions(
  config: ConversationModelConfig,
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): ConversationModelConfig {
  if (providerOptions === undefined) return config;
  return {
    ...config,
    answer: {
      ...config.answer,
      providerOptions: { ...config.answer.providerOptions, ...providerOptions },
    },
  };
}
