/** Static conversation tool registry; authorization and AI SDK tools derive from one definition. */

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
