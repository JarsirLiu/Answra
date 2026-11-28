/**
 * `sentence-pipeline`：边收增量边切句，有界并发合成，按 sequence 产出。
 *
 * 合成完成顺序可能乱，但对外只按 sequence 产出；宿主与 UI 都不需要排序或缓冲。
 */

import { createSpeechSanitizer } from "../chunk/sanitize";
import { createStreamingChunker } from "../chunk/stream";
import type { TtsSynthesisResult } from "../contracts";
import { abortedError } from "../errors";
import type { TtsProviderPort } from "../port";
import type { TtsSegmentAudio, TtsUtterance } from "../utterance";
import type { TtsChunkTuning, TtsStrategy, TtsStrategyContext, TtsStrategyOptions } from "./types";

const DEFAULT_CONCURRENCY = 2;

export function createSentencePipelineStrategy(options: TtsStrategyOptions = {}): TtsStrategy {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const tuning = options.chunk;
  return {
    speak(utterance: TtsUtterance, context: TtsStrategyContext): AsyncIterable<TtsSegmentAudio> {
      return runPipeline(utterance, context.port, context.signal, concurrency, tuning);
    },
  };
}

async function* runPipeline(
  utterance: TtsUtterance,
  port: TtsProviderPort,
  signal: AbortSignal | undefined,
  concurrency: number,
  tuning: TtsChunkTuning | undefined,
): AsyncGenerator<TtsSegmentAudio> {
  const internal = new AbortController();
  const combined =
    signal === undefined ? internal.signal : AbortSignal.any([signal, internal.signal]);
  const queue = new OrderedAudioQueue(utterance.messageId);

  const failOnAbort = (): void => queue.fail(abortedError());
  if (combined.aborted) queue.fail(abortedError());
  else combined.addEventListener("abort", failOnAbort, { once: true });

  const producer = produce();
  try {
    yield* queue.drain();
  } finally {
    combined.removeEventListener("abort", failOnAbort);
    internal.abort();
    void producer.catch(() => undefined);
  }

  async function produce(): Promise<void> {
    const sanitizer = createSpeechSanitizer();
    const chunker = createStreamingChunker({
      maxChars: port.capabilities.maxChars,
      ...tuning,
    });
    const tasks = new Set<Promise<void>>();
    let sequence = 0;
    let failed = false;

    const launch = (text: string): void => {
      const current = sequence;
      sequence += 1;
      const task = (async () => {
        try {
          const result = await port.synthesize({ text, signal: combined });
          queue.push(current, result);
        } catch (error) {
          if (!failed) {
            failed = true;
            queue.fail(error);
            internal.abort();
          }
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    };

    const waitForSlot = async (): Promise<void> => {
      while (tasks.size >= concurrency) await Promise.race(tasks);
    };

    try {
      for await (const raw of utterance.text) {
        if (failed || combined.aborted) break;
        for (const text of chunker.push(sanitizer.push(raw))) {
          if (failed) break;
          launch(text);
          await waitForSlot();
        }
      }
      if (!failed && !combined.aborted) {
        for (const text of chunker.push(sanitizer.flush())) {
          launch(text);
          await waitForSlot();
        }
        for (const text of chunker.flush()) {
          launch(text);
          await waitForSlot();
        }
      }
      await Promise.all(tasks);
    } catch (error) {
      if (!failed) {
        failed = true;
        queue.fail(error);
      }
    } finally {
      queue.close();
    }
  }
}

/** 按 sequence 排序的音频队列：合成乱序完成也不会打乱播放。 */
class OrderedAudioQueue {
  private readonly ready = new Map<number, TtsSynthesisResult>();
  private next = 0;
  private closed = false;
  private failure: unknown = null;
  private wake: (() => void) | null = null;

  constructor(private readonly messageId: string) {}

  push(sequence: number, result: TtsSynthesisResult): void {
    if (this.closed) return;
    this.ready.set(sequence, result);
    this.notify();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.notify();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.notify();
  }

  async *drain(): AsyncGenerator<TtsSegmentAudio> {
    while (true) {
      if (this.failure !== null) throw this.failure;

      const result = this.ready.get(this.next);
      if (result !== undefined) {
        this.ready.delete(this.next);
        const segment: TtsSegmentAudio = {
          messageId: this.messageId,
          sequence: this.next,
          ...result,
        };
        this.next += 1;
        yield segment;
        continue;
      }

      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
