/** 把已校验的用户输入映射成 transcript 中的完整用户消息。 */
import type { ConversationMessage, ConversationSendRequest } from "@answra/shared";
export function createUserMessage(
  id: string,
  request: ConversationSendRequest,
): ConversationMessage {
  return {
    id,
    role: "user",
    text: request.text,
    images: request.images.map((image) => ({ ...image })),
    status: "complete",
  };
}
