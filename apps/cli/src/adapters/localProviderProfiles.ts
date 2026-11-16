/**
 * 本地模型端点的 provider 适配：把已知供应商要求转换为端点字段。
 * 只补非 secret headers 与会话头；不读取凭据、不改变模型设置语义。
 */
import type { ConversationCapabilityEndpoint, ConversationModelConfig } from "@answra/shared";
import type { ModelSettings } from "../model/ports";
import { CLI_VERSION } from "../version";

const OPENCODE_GO_USER_AGENT = `answra-cli/${CLI_VERSION}`;
const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

interface LocalProviderProfile {
  matches(url: URL): boolean;
  headers: Readonly<Record<string, string>>;
  sessionHeader: string;
}

const OPENCODE_GO_PROFILE: LocalProviderProfile = {
  matches: (url) =>
    url.hostname === "opencode.ai" &&
    (url.pathname.startsWith("/inference/go/") || url.pathname.startsWith("/zen/go/")),
  headers: { "User-Agent": OPENCODE_GO_USER_AGENT },
  sessionHeader: OPENCODE_GO_SESSION_HEADER,
};

const LOCAL_PROVIDER_PROFILES = [OPENCODE_GO_PROFILE];

export function withLocalProviderProfiles(settings: ModelSettings): ModelSettings {
  return {
    resolve: async (overrides) => applyProfiles(await settings.resolve(overrides)),
    addLocal: async (input) => applyProfiles(await settings.addLocal(input)),
    switchChatModel: async (chatModel) => applyProfiles(await settings.switchChatModel(chatModel)),
    snapshot: () => settings.snapshot(),
    clearLocal: () => settings.clearLocal(),
  };
}

function applyProfiles(config: ConversationModelConfig): ConversationModelConfig {
  return {
    chat: applyProfile(config.chat),
    answer: applyProfile(config.answer),
  };
}

function applyProfile(endpoint: ConversationCapabilityEndpoint): ConversationCapabilityEndpoint {
  const url = new URL(endpoint.baseUrl);
  const profile = LOCAL_PROVIDER_PROFILES.find((item) => item.matches(url));
  if (profile === undefined) return endpoint;
  return {
    ...endpoint,
    headers: { ...profile.headers, ...endpoint.headers },
    sessionHeader: endpoint.sessionHeader ?? profile.sessionHeader,
  };
}
