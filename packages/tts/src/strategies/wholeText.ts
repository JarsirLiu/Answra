/** `whole-text`：攒完全文再切、串行合成；手动朗读与短回复用。 */
import { sanitizeSpeechText } from "../chunk/sanitize";
import { splitSpeechText } from "../chunk/split";
import { abortedError } from "../errors";
import type { TtsSegmentAudio, TtsUtterance } from "../utterance";
import type { TtsStrategy, TtsStrategyContext } from "./types";

export function createWholeTextStrategy(): TtsStrategy {
  return {
    async *speak(
      utterance: TtsUtterance,
      context: TtsStrategyContext,
    ): AsyncGenerator<TtsSegmentAudio> {
      let raw = "";
      for await (const delta of utterance.text) {
        if (context.signal?.aborted === true) throw abortedError();
        raw += delta;
      }

      const segments = splitSpeechText(sanitizeSpeechText(raw), context.port.capabilities.maxChars);
      let sequence = 0;
      for (const text of segments) {
        if (context.signal?.aborted === true) throw abortedError();
        const result = await context.port.synthesize({ text, signal: context.signal });
        yield { messageId: utterance.messageId, sequence, ...result };
        sequence += 1;
      }
    },
  };
}
