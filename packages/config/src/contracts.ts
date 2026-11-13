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

export interface ClientConfig {
  readonly version: typeof CLIENT_CONFIG_VERSION;
  readonly model: ClientModelConfig;
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
