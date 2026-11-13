/** CLI 的共享配置适配器：唯一读写 `@answra/config` 文件的实现，不解释模型语义。 */
import {
  type ClientConfig,
  readClientConfig,
  resolveDefaultConfigPath,
  writeClientConfig,
} from "@answra/config";
import type { ModelSettingsStore } from "../model/ports";

export function createSharedModelStore(
  filePath: string = resolveDefaultConfigPath(),
): ModelSettingsStore {
  return {
    async read(): Promise<ClientConfig | null> {
      try {
        return await readClientConfig(filePath);
      } catch (error) {
        throw new Error(`无法读取共享模型配置：${messageOf(error)}`);
      }
    },
    async write(config: ClientConfig): Promise<void> {
      try {
        await writeClientConfig(filePath, config);
      } catch (error) {
        throw new Error(`无法写入共享模型配置：${messageOf(error)}`);
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
