/** AI SDK UIMessageChunk 到 Conversation 稳定模型事件的消费适配。 */
import type { AgentStreamEvent } from "@answra/shared/schema";
import type { UIMessageChunk } from "ai";
import { normalizeStreamChunk } from "./streamEvents";

export async function consumeModelStream(
  chunks: AsyncIterable<UIMessageChunk>,
  append: (stream: AgentStreamEvent) => Promise<void>,
): Promise<void> {
  for await (const chunk of chunks) {
    const stream = normalizeStreamChunk(chunk);
    if (stream) await append(stream);
  }
}
