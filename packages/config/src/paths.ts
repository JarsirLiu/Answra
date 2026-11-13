/** 共享配置目录：桌面与 CLI 必须落到同一个 Answra 数据根。 */
import { homedir } from "node:os";
import path from "node:path";
import { CLIENT_CONFIG_FILE } from "./contracts";

export interface DefaultConfigDirOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

export function resolveDefaultConfigDir(options: DefaultConfigDirOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Answra");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Answra");
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Answra");
}

export function sharedConfigPath(configDir: string): string {
  return path.join(configDir, CLIENT_CONFIG_FILE);
}

export function resolveDefaultConfigPath(options: DefaultConfigDirOptions = {}): string {
  return sharedConfigPath(resolveDefaultConfigDir(options));
}
