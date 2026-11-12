/** CLI 工作区根目录解析：在进入 Agent 之前显式校验目录存在。 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { CliConfigError } from "../cli/errors";

export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolved);
  } catch {
    throw new CliConfigError(`工作目录不存在：${resolved}`);
  }
  if (!info.isDirectory()) throw new CliConfigError(`工作目录不是目录：${resolved}`);
  return resolved;
}
