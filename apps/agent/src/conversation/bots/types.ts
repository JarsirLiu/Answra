/** Conversation 的 Bot 目录类型：执行器与 profile 由本领域装配。 */

import type { ConversationAgentInput } from "../../bots/general/agent";
import type { ConversationBot } from "../../bots/general/bot";
import type { ChatProfile } from "../../bots/general/profile";
import type { BotCatalog } from "../../core/bot/catalog";

export type { ConversationBot };
export type ConversationBotCatalog = BotCatalog<ConversationAgentInput, ChatProfile>;
