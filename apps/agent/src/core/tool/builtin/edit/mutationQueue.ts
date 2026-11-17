/** Edit 的按路径写队列：同一文件的读取、匹配和写回串行，避免并发交错。 */

import path from "node:path";

const queues = new Map<string, Promise<void>>();

export async function withEditMutationQueue<T>(
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = mutationQueueKey(target);
  const previous = queues.get(key) ?? Promise.resolve();

  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

function mutationQueueKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
