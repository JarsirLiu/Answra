/** Screenshot Answer use case: owns one-shot transcript lifecycle, not model execution. */
import { randomUUID } from "node:crypto";
import type { ConversationSendRequest, ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot, RunOutcome } from "@answra/shared/schema";
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
    const { event, runId, aggregateRevision } = envelope;
    if (event.type === "text-delta")
      await this.store.applyStreamEvent(conversationId, runId, event);
    if (event.type !== "run-state-changed") return;

    const outcome = runOutcomeForState(event.state);
    if (!outcome) return;
    await this.store.finishRun(conversationId, runId, outcome, aggregateRevision);
    if (outcome !== "failed") await this.store.clear(conversationId, aggregateRevision);
  }
}

function runOutcomeForState(state: string): RunOutcome | undefined {
  switch (state) {
    case "completed":
    case "failed":
    case "aborted":
      return state;
    case "superseded":
      return "superseded";
    default:
      return undefined;
  }
}
