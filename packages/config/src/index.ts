/** @answra/config：桌面与 CLI 共享的非 secret 客户端配置。 */
export {
  CLIENT_CONFIG_FILE,
  CLIENT_CONFIG_VERSION,
  type ClientAnswerConfig,
  type ClientConfig,
  type ClientModelConfig,
  defaultClientConfig,
  type LocalModelConfig,
} from "./contracts";
export {
  type LocalModelPatch,
  mergeLocalModel,
  normalizeLocalModel,
} from "./localModel";
export {
  type DefaultConfigDirOptions,
  resolveDefaultConfigDir,
  resolveDefaultConfigPath,
  sharedConfigPath,
} from "./paths";
export { readProviderOptions } from "./providerOptions";
export { normalizeBaseUrl, parseClientConfig, readClientConfig, writeClientConfig } from "./store";
