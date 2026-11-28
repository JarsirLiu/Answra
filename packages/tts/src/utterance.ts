/** 与协议无关的朗读输入输出。 */

/** 一次朗读的文本增量流；`messageId` 决定音频帧归属。 */
export interface TtsUtterance {
  readonly messageId: string;
  readonly text: AsyncIterable<string>;
}

/** 策略产出的段音频；`sequence` 由策略分配并保证递增。 */
export interface TtsSegmentAudio {
  readonly messageId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly durationMs?: number;
}
