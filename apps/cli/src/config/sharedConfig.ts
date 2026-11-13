/** 读取桌面端写入的共享客户端配置；CLI 只消费其中的本地模型字段。 */
import { type ClientConfig, readClientConfig, resolveDefaultConfigPath } from "@answra/config";
import { CliConfigError } from "../cli/errors";

export async function loadSharedClientConfig(): Promise<ClientConfig | null> {
  try {
    return await readClientConfig(resolveDefaultConfigPath());
  } catch (error) {
    throw new CliConfigError(
      `无法读取共享模型配置：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}
