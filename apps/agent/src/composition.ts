/// <reference path="./types/pdfjs-dist-worker.d.ts" />
/// <reference path="./types/word-extractor.d.ts" />

export {
  CODING_AGENT_ID,
  CODING_DISCOVERY,
  CODING_IDENTITY,
  type CodingAgentInput,
  createAgentDefinition as createCodingAgentDefinition,
} from "./bots/coding/agent";
export { type CodingBot, createCodingBot } from "./bots/coding/bot";
export { CODING_POLICY, type CodingPolicy } from "./bots/coding/policy";
export {
  CONVERSATION_TEAM_ID,
  type ConversationAgentInput,
  type ConversationAgentOptions,
  type ConversationAgentProfile,
  createAgentDefinition as createConversationAgentDefinition,
  GENERAL_AGENT_ID as CONVERSATION_AGENT_ID,
  GENERAL_DISCOVERY,
  GENERAL_IDENTITY,
} from "./bots/general/agent";
export {
  type ConversationBot,
  type ConversationBotOptions,
  createGeneralBot as createConversationBot,
} from "./bots/general/bot";
export {
  CHAT_PROFILES,
  type ChatProfile,
  type ChatProfileId,
} from "./bots/general/profile";
export {
  type BotFactoryDeps,
  createGeneralConversationBot,
} from "./bots/registry";
export {
  CodingApplication,
  type CodingApplicationOptions,
} from "./coding/application";
export { type CodingHost, type CodingHostOptions, startCodingHost } from "./coding/host";
export {
  ConversationApplication,
  type ConversationApplicationOptions,
} from "./conversation/application";
export { createConversationBots } from "./conversation/bots";
export type { ConversationBotCatalog } from "./conversation/bots/types";
export {
  type AgentDefinition,
  type AgentExecutor,
  type AgentId,
  type AgentModelRoutes,
  agentId,
  type BotDiscovery,
  type BotIdentity,
  type BotTurnResult,
  type BotVisibility,
} from "./core/agent/definition";
export { AgentRuntime, type AgentRuntimeOptions } from "./core/agent/runtime";
export { type BotCatalog, createBotCatalog } from "./core/bot/catalog";
export {
  type BotDescriptor,
  type BotDomain,
  type BotSummary,
  type BotTeamLookup,
  summarizeBot,
} from "./core/bot/contracts";
export {
  assertBotDiscoveryReferences,
  assertCanHandoff,
  visibleBots,
} from "./core/bot/directory";
export { SqliteSessionJournal } from "./core/session/sqliteJournal";
export * from "./core/skill";
export { assertHandoffTask, MAX_HANDOFF_TASK_CHARS } from "./core/team/handoff";
export {
  assertTeamPreset,
  createTeamPresetCatalog,
  type TeamPreset,
  type TeamPresetCatalog,
} from "./core/team/preset";
export * from "./core/tool";
export type {
  ConversationMessageCatalog,
  ConversationMessagePage,
  ConversationMessageQuery,
  ConversationSessionCatalog,
  ConversationSessionQuery,
} from "./core/transcript/catalog";
export { MemoryConversationStore } from "./core/transcript/memoryStore";
export { SqliteConversationStore } from "./core/transcript/persistence/sqlite/sqliteConversationStore";
export type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStore,
} from "./core/transcript/store";
export { MemoryExecutionStore } from "./execution/memoryStore";
export type { ExecutionStore } from "./execution/store";
