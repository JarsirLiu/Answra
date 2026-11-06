/** Conversation 静态工具注册表；授权判断与 AI SDK tool set 共用同一份定义。 */

import type { ToolSet } from "ai";
import { grepDefinition } from "./grep";
import { readDefinition } from "./read";
import type { ConversationToolContext, ConversationToolId } from "./types";

const definitions = [readDefinition, grepDefinition] as const;

export function createAuthorizedConversationTools(
  authorizedIds: readonly ConversationToolId[],
  context: ConversationToolContext,
) {
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (authorizedIds.includes(definition.id)) tools[definition.name] = definition.create(context);
  }
  return tools;
}

export function getConversationToolDefinitions() {
  return definitions;
}
