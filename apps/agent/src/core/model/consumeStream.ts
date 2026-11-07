/** AI SDK fullStream 到唯一 Agent 事实事件流的消费适配。 */
import type { AgentEvent } from "@answra/shared/schema";
import type { TextStreamPart, ToolSet } from "ai";
import { normalizeStreamPart } from "./streamEvents";

export async function consumeModelStream(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  append: (event: AgentEvent) => Promise<void>,
): Promise<void> {
  let stepIndex = -1;
  for await (const part of parts) {
    if (part.type === "start-step") stepIndex += 1;
    const normalized = normalizeStreamPart(part, { stepIndex });
    if (normalized === undefined) continue;
    for (const event of Array.isArray(normalized) ? normalized : [normalized]) {
      await append(event);
    }
  }
}
