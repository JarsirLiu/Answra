/**
 * CLI 模型设置域的端口与跨层 DTO；不依赖 fs、Ink、argv 或会话生命周期。
 * 唯一文件实现位于 `apps/cli/src/adapters/sharedModelStore.ts`，由 `main.ts` 注入。
 */
import type { ClientConfig, LocalModelConfig } from "@answra/config";
import type { ConversationModelConfig, ConversationModelSource } from "@answra/shared";

/**
 * 单次解析中的一层覆盖。字段缺省表示继续向下一层查找，空字符串视为未提供。
 * 不包含 API Key：凭据由命令层从环境变量或参数注入，不进入模型设置域。
 */
export interface ModelOverrides {
  readonly baseUrl?: string;
  readonly chatModel?: string;
}

/** 用户通过 `answra config set` 或 `/model add` 提交的本地模型；不含 secret。 */
export interface LocalModelInput {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly answerModel?: string;
}

/** 无 secret 的模型设置摘要，供 `config show` 与 `/model` 展示。 */
export interface ModelSettingsSnapshot {
  readonly source: ConversationModelSource;
  readonly local: LocalModelConfig;
  readonly configured: boolean;
}

/**
 * 共享配置文件端口。实现只做 `@answra/config` 的读写，不解释优先级或 source；
 * 合并与校验策略由 `ModelSettings` 维护，避免第二个写者分叉。
 */
export interface ModelSettingsStore {
  read(): Promise<ClientConfig | null>;
  write(config: ClientConfig): Promise<void>;
}

/**
 * 模型设置应用服务端口。命令层与 TUI 只依赖这个接口：
 *
 * - `resolve`：按传入顺序逐字段取第一个非空覆盖，最后回退到共享 `model.local`；
 * - `addLocal`：校验并写入共享本地模型，把 `source` 切到 `local`；
 * - `switchChatModel`：在已配置的本地端点上替换 chat 模型并持久化；
 * - `clearLocal`：清空共享 `model.local`，把 `source` 置回 `cloud`；
 * - `snapshot`：返回无 secret 摘要，不读环境变量。
 *
 * 实现不得保存或返回 API Key；凭据由命令层从 env/flag 注入会话。
 */
export interface ModelSettings {
  resolve(overrides: readonly ModelOverrides[]): Promise<ConversationModelConfig>;
  snapshot(): Promise<ModelSettingsSnapshot>;
  addLocal(input: LocalModelInput): Promise<ConversationModelConfig>;
  switchChatModel(chatModel: string): Promise<ConversationModelConfig>;
  clearLocal(): Promise<void>;
}
