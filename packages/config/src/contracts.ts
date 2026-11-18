/** 共享客户端配置契约：只放桌面与 CLI 都可复用的非 secret 字段。 */
import type { ConversationModelSource } from "@answra/shared";

export const CLIENT_CONFIG_VERSION = 1 as const;
export const CLIENT_CONFIG_FILE = "config.json";

export interface LocalModelConfig {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly answerModel?: string;
}

export interface ClientModelConfig {
  /** 桌面端当前选择的来源；CLI 目前只消费 local，未来云端登录再读取该字段。 */
  readonly source: ConversationModelSource;
  readonly local: LocalModelConfig;
}

/** 截图答题的本地扩展参数；不区分来源，云端与本地端点共用。 */
export interface ClientAnswerConfig {
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export interface ClientConfig {
  readonly version: typeof CLIENT_CONFIG_VERSION;
  readonly model: ClientModelConfig;
  readonly answer?: ClientAnswerConfig;
}

export function defaultClientConfig(): ClientConfig {
  return {
    version: CLIENT_CONFIG_VERSION,
    model: {
      source: "cloud",
      local: { baseUrl: "", chatModel: "" },
    },
  };
}
