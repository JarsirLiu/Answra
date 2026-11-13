/** @answra/config：桌面与 CLI 共享的非 secret 客户端配置。 */
export {
  CLIENT_CONFIG_FILE,
  CLIENT_CONFIG_VERSION,
  type ClientConfig,
  type ClientModelConfig,
  defaultClientConfig,
  type LocalModelConfig,
} from "./contracts";
export {
  type DefaultConfigDirOptions,
  resolveDefaultConfigDir,
  resolveDefaultConfigPath,
  sharedConfigPath,
} from "./paths";
export { normalizeBaseUrl, parseClientConfig, readClientConfig, writeClientConfig } from "./store";
