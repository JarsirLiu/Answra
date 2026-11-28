/**
 * TTS 播放：订阅 main 推送的音频帧，按到达顺序串行播放，按 `messageId + sequence` 去重。
 *
 * 不判断 provider、不解析文本、不持凭证；停止信号一到立即清空队列并释放 Blob URL。
 * `manual` 帧不参与去重：用户点「朗读」就是要重播。
 */
import type { DesktopBridge, TtsAudioFrame, TtsFailureEvent, TtsStopPayload } from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";

/** 可播放音频的最小端口；测试注入假实现，生产用 `HTMLAudioElement`。 */
export interface PlayableAudio {
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export type CreatePlayableAudio = (url: string) => PlayableAudio;

export interface TtsPlayback {
  failure: string | undefined;
  dismissFailure: () => void;
}

function createAudioElement(url: string): PlayableAudio {
  return new Audio(url);
}

export function useTtsPlayback(
  platform: DesktopBridge | undefined,
  createAudio: CreatePlayableAudio = createAudioElement,
): TtsPlayback {
  const [failure, setFailure] = useState<string>();
  const queue = useRef<TtsAudioFrame[]>([]);
  const played = useRef(new Set<string>());
  const urls = useRef(new Set<string>());
  const current = useRef<PlayableAudio | undefined>(undefined);
  const playing = useRef(false);
  const disposed = useRef(false);

  const playNext = useCallback(() => {
    if (playing.current || disposed.current) return;
    const frame = queue.current.shift();
    if (frame === undefined) return;

    playing.current = true;
    const bytes = new Uint8Array(frame.bytes);
    const url = URL.createObjectURL(new Blob([bytes], { type: frame.mimeType }));
    urls.current.add(url);
    const audio = createAudio(url);
    current.current = audio;

    const finish = (failed: boolean): void => {
      if (current.current !== audio) return;
      current.current = undefined;
      audio.onended = null;
      audio.onerror = null;
      URL.revokeObjectURL(url);
      urls.current.delete(url);
      playing.current = false;
      if (failed) {
        queue.current = [];
        setFailure("无法播放合成音频。");
        return;
      }
      playNext();
    };

    audio.onended = () => finish(false);
    audio.onerror = () => finish(true);
    void Promise.resolve(audio.play()).catch(() => finish(true));
  }, [createAudio]);

  const stop = useCallback(() => {
    queue.current = [];
    const audio = current.current;
    current.current = undefined;
    playing.current = false;
    if (audio !== undefined) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);

  useEffect(() => {
    disposed.current = false;
    const unsubscribeAudio = platform?.onTtsAudio?.((frame) => {
      if (frame.source === "auto") {
        const key = `${frame.messageId}:${frame.sequence}`;
        if (played.current.has(key)) return;
        played.current.add(key);
      }
      queue.current.push(frame);
      playNext();
    });
    const unsubscribeStopped = platform?.onTtsStopped?.((_payload: TtsStopPayload) => {
      stop();
    });
    const unsubscribeFailed = platform?.onTtsFailed?.((event: TtsFailureEvent) => {
      // 取消是正常路径：main 已经推 Stop，不能再弹一条失败。
      if (event.failure.code === "aborted") return;
      setFailure(event.failure.message);
    });
    return () => {
      disposed.current = true;
      unsubscribeAudio?.();
      unsubscribeStopped?.();
      unsubscribeFailed?.();
      stop();
    };
  }, [platform, playNext, stop]);

  const dismissFailure = useCallback(() => setFailure(undefined), []);

  return { failure, dismissFailure };
}
