/** Conversation 的 Bot 目录类型：执行器与 profile 由本领域装配。 */
import type { BotCatalog } from "../../core/bot/catalog";
import type { BotDescriptor } from "../../core/bot/contracts";
import type { ConversationAgentInput } from "../agent";
import type { ChatProfile } from "../profiles/registry";

export type ConversationBot = BotDescriptor<ConversationAgentInput, ChatProfile>;
export type ConversationBotCatalog = BotCatalog<ConversationAgentInput, ChatProfile>;
