/** Screenshot Answer use case: owns one-shot transcript lifecycle, not model execution. */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot } from "@answra/shared/schema";
import type { AgentExecutor } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import { validateModelRequest } from "../core/model/requestContent";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationStore } from "../core/transcript/store";

export interface AnswerApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  executor: AgentExecutor<ConversationSendRequest>;
}

export class AnswerApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly executor: AgentExecutor<ConversationSendRequest>;

  constructor({ agentRuntime, store, executor }: AnswerApplicationOptions) {
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.executor = executor;
  }

  async run(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    validateModelRequest(request);
    const { runId, prepared } = await this.executor.startRun({
      conversationId,
      getAccessToken: async () => accessToken,
      prepareRun: async ({ runId, eventRevision }) => {
        await this.store.create(conversationId);
        await this.store.beginEphemeralRun(
          conversationId,
          runId,
          createUserMessage(randomUUID(), request),
          eventRevision,
        );
        return {
          input: request,
          prepared: await this.store.load(conversationId),
        };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
    return { runId, snapshot: prepared };
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  async getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  readEventsAfter(conversationId: string, revision: number): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEvents(conversationId, revision);
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId);
    return this.getSnapshot(conversationId);
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    const eventRevision = await this.agentRuntime.getConversationRevision(conversationId);
    await this.store.clear(conversationId, eventRevision);
    return this.getSnapshot(conversationId);
  }

  async appendUserMessage(conversationId: string, text: string): Promise<ConversationSnapshot> {
    if (typeof text !== "string" || !text.trim() || text.length > 32_000)
      throw new Error("消息内容无效或过长");
    return this.store.appendUserMessage(
      conversationId,
      createUserMessage(randomUUID(), { text: text.trim(), images: [] }),
    );
  }

  cancel(runId: string): void {
    this.agentRuntime.cancel(runId);
  }

  waitForRun(runId: string): Promise<void> {
    return this.agentRuntime.waitForRun(runId);
  }

  getExecutionRun(runId: string): Promise<AgentRunSnapshot | undefined> {
    return this.agentRuntime.getRun(runId);
  }

  readExecutionEvents(runId: string): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEventsForRun(runId);
  }

  dispose(): void {
    this.agentRuntime.dispose();
  }

  get activeRunCount(): number {
    return this.agentRuntime.activeRunCount;
  }

  private async applyRunEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void> {
    await this.store.applyAgentEvent(conversationId, envelope);
    if (envelope.event.type !== "run-state-changed") return;
    if (!isTerminalOutcome(envelope.event.state)) return;
    if (envelope.event.state !== "failed")
      await this.store.clear(conversationId, envelope.aggregateRevision);
  }
}

function isTerminalOutcome(
  state: AgentEventEnvelope["event"] extends infer _ ? string : never,
): boolean {
  switch (state) {
    case "completed":
    case "failed":
    case "aborted":
    case "superseded":
    case "orphaned":
      return true;
    default:
      return false;
  }
}
