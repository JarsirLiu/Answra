/** 模型访问令牌优先级：显式参数/环境变量优先，其次 OS 凭据库；不读取共享配置。 */
import type { ModelCredentialStore } from "@answra/credentials";

export async function resolveModelAccessToken(
  explicit: string | undefined,
  credentials: ModelCredentialStore,
): Promise<string> {
  const value = explicit?.trim() ?? "";
  if (value !== "") return value;
  return (await credentials.read()) ?? "";
}
