/**
 * 宿主侧的增量文本通道：把 agent 的 `tts-speak` 帧攒成 `AsyncIterable<string>`。
 *
 * 只做排队与关闭；切句、净化和合成在 `@answra/tts`。缓冲有界，超限显式失败，
 * 不允许一条长回复把内存撑成无界队列。
 */
import { TtsProviderError } from "@answra/tts";

const MAX_PENDING_CHUNKS = 64;

export interface TtsTextChannel {
  readonly text: AsyncIterable<string>;
  push(delta: string): void;
  finish(): void;
  fail(error: unknown): void;
}

export function createTtsTextChannel(): TtsTextChannel {
  const pending: string[] = [];
  let failure: unknown;
  let closed = false;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  const text: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (failure !== undefined) throw failure;
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  return {
    text,
    push(delta: string): void {
      if (closed) return;
      if (pending.length >= MAX_PENDING_CHUNKS) {
        failure = new TtsProviderError("invalid-request", "朗读文本增量超过缓冲上限。");
        closed = true;
        notify();
        return;
      }
      if (delta === "") return;
      pending.push(delta);
      notify();
    },
    finish(): void {
      if (closed) return;
      closed = true;
      notify();
    },
    fail(error: unknown): void {
      if (closed) return;
      failure = error;
      closed = true;
      notify();
    },
  };
}
