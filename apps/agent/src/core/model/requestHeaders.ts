/** 端点声明的请求级 headers 投影；不推导 provider，也不包含凭据。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";

export function requestHeadersFor(
  endpoint: Pick<ConversationCapabilityEndpoint, "sessionHeader">,
  conversationId: string,
): Record<string, string> | undefined {
  const header = endpoint.sessionHeader?.trim() ?? "";
  if (header === "") return undefined;
  return { [header]: conversationId };
}
