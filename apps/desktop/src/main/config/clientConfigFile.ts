/**
 * 共享 config.json 的唯一读改写入口：model 与 tts 分段写入。
 *
 * 两个设置域写同一个文件，必须读-改-写并串行执行，否则后写的一方会覆盖另一方。
 */
import { rm } from "node:fs/promises";
import { type ClientConfig, readClientConfig, writeClientConfig } from "@answra/config";

const queues = new Map<string, Promise<unknown>>();

/** 串行执行 `update`；返回写回后的配置，`update` 返回 null 表示删除文件。 */
export function updateClientConfig(
  filePath: string,
  update: (current: ClientConfig | null) => ClientConfig | null,
): Promise<ClientConfig | null> {
  const previous = queues.get(filePath) ?? Promise.resolve();
  const next = previous.then(() => applyUpdate(filePath, update));
  // 队列只用于排序；某次失败不能阻塞后续写入，错误仍原样抛给本次调用方。
  queues.set(
    filePath,
    next.catch(() => undefined),
  );
  return next;
}

async function applyUpdate(
  filePath: string,
  update: (current: ClientConfig | null) => ClientConfig | null,
): Promise<ClientConfig | null> {
  const current = await readClientConfig(filePath);
  const updated = update(current);
  if (updated === null) {
    await rm(filePath, { force: true });
    return null;
  }
  await writeClientConfig(filePath, updated);
  return updated;
}
