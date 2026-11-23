/**
 * Screenshot Answer use case：一次性答题会话只走内存条目与单 Turn SessionRuntime，
 * 不读 transcript 历史、不落盘、不参与启动恢复。
 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { SessionFrame, TurnOutcome } from "@answra/shared/schema";
import type { AgentExecutor, AgentId } from "../core/agent/definition";
import { ProviderStepRunner } from "../core/agent/providerStepRunner";
import type { AgentRuntime } from "../core/agent/runtime";
import { validateModelRequest } from "../core/model/requestContent";
import type { SessionId, StepRunner, StepStart, TurnId } from "../core/session/contracts";
import { sessionId as asSessionId, turnId as asTurnId } from "../core/session/contracts";
import { SessionItemRecorder } from "../core/session/itemRecorder";
import { SessionFrameBus } from "../core/session/sessionFrameBus";
import { SessionRuntime } from "../core/session/sessionRuntime";
import { SessionStepExecutor } from "../core/session/stepExecutor";
import { SessionTurnExecutor } from "../core/session/turnExecutor";
import type { SessionItemStore } from "../core/transcript/itemStore";
import { MemorySessionItemStore } from "../core/transcript/memoryItemStore";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationStore } from "../core/transcript/store";

export interface AnswerApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  executor: AgentExecutor<ConversationSendRequest>;
  /** 一次性答题的 assistant 消息归属；每次 Turn 都显式写入。 */
  authorAgentId: AgentId;
  /** 与其它领域共用同一帧广播口时注入；缺省自建。 */
  sessionFrames?: SessionFrameBus;
  /** 内存条目；Answer 事实不落盘，也不进入启动恢复。 */
  sessionItems?: SessionItemStore;
  /** 测试注入的 StepRunner；生产由 ProviderStepRunner 提供。 */
  stepRunner?: StepRunner;
}

export class AnswerApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly executor: AgentExecutor<ConversationSendRequest>;
  private readonly authorAgentId: AgentId;
  private readonly sessionFrames: SessionFrameBus;
  private readonly sessionRuntime: SessionRuntime;
  /** 每个会话至多一个活动 Turn；同步占位保证并发提交被原子拒绝。 */
  private readonly active = new Map<string, TurnId | "claiming">();
  private closing = false;

  constructor({
    agentRuntime,
    store,
    executor,
    authorAgentId,
    sessionFrames,
    sessionItems,
    stepRunner,
  }: AnswerApplicationOptions) {
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.executor = executor;
    this.authorAgentId = authorAgentId;
    this.sessionFrames = sessionFrames ?? new SessionFrameBus();
    const items = sessionItems ?? new MemorySessionItemStore();
    const recorder = new SessionItemRecorder({ items, store, frames: this.sessionFrames });
    const runner =
      stepRunner ??
      new ProviderStepRunner({
        getEndpoint: () => this.agentRuntime.answerEndpoint(),
        prepare: (step, signal, emitter) =>
          this.executor.prepare(requestFor(step), signal, emitter),
        tokenProvider: this.agentRuntime.modelTokenProvider?.(),
      });
    const stepExecutor = new SessionStepExecutor({ recorder, runner });
    const turnExecutor = new SessionTurnExecutor({
      recorder,
      stepExecutor,
      createMessageId: () => randomUUID(),
    });
    this.sessionRuntime = new SessionRuntime({
      items,
      store,
      recorder,
      executor: turnExecutor,
      defaults: { agentId: this.authorAgentId, source: "user" },
      createMessageId: () => randomUUID(),
    });
  }

  async run(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    validateModelRequest(request);
    if (this.closing) throw new Error("会话正在关闭");
    // 检查与占位必须在第一个 await 之前完成：两个并发提交只能有一个活下来。
    if (this.active.has(conversationId)) throw new Error("当前回复尚未完成");
    this.active.set(conversationId, "claiming");
    try {
      await this.store.create(conversationId, undefined, { scope: "answer" });
      await this.sessionRuntime.createSession(asSessionId(conversationId));
      const submission = await this.sessionRuntime.submit({
        sessionId: asSessionId(conversationId),
        source: "user",
        agentId: this.authorAgentId,
        input: createUserMessage(randomUUID(), request),
        runtime: { getAccessToken: async () => accessToken },
      });
      this.active.set(conversationId, submission.turnId);
      void this.settle(conversationId, submission.turnId);
      return {
        turnId: submission.turnId,
        snapshot: await this.store.load(conversationId),
      };
    } catch (error) {
      this.active.delete(conversationId);
      throw error;
    }
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  async getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  /** 按 durable `seq` 读取条目帧；Answer 的条目只在内存里。 */
  async readFramesAfter(conversationId: string, afterSeq: number): Promise<SessionFrame[]> {
    return this.sessionRuntime.readFramesAfter(asSessionId(conversationId), afterSeq);
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId, undefined, { scope: "answer" });
    await this.sessionRuntime.createSession(asSessionId(conversationId));
    return this.getSnapshot(conversationId);
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    const session = asSessionId(conversationId);
    const active = this.active.get(conversationId);
    if (active !== undefined && active !== "claiming") {
      await this.sessionRuntime
        .cancel(session, active, { cancelQueued: true })
        .catch(() => undefined);
    }
    await this.release(session);
    this.active.delete(conversationId);
    return this.getSnapshot(conversationId);
  }

  async appendUserMessage(conversationId: string, text: string): Promise<ConversationSnapshot> {
    if (typeof text !== "string" || !text.trim() || text.length > 32_000)
      throw new Error("消息内容无效或过长");
    return this.sessionRuntime.appendUserMessage(
      asSessionId(conversationId),
      createUserMessage(randomUUID(), { text: text.trim(), images: [] }),
    );
  }

  cancel(conversationId: string, turnId: string): void {
    void this.sessionRuntime
      .cancel(asSessionId(conversationId), asTurnId(turnId), { cancelQueued: true })
      .catch((error: unknown) => {
        console.warn("[answer] cancel failed", {
          turnId,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
  }

  /** 退出屏障：先中止活动 Turn，等终态写入后再释放 scheduler。 */
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.sessionRuntime.shutdown();
  }

  dispose(): void {
    this.closing = true;
    this.sessionRuntime.dispose();
    this.agentRuntime.dispose();
  }

  /**
   * Turn 结束后一次性会话只保留到用户看完：成功与取消都清掉 transcript 与条目，
   * 失败轮保留给回复条展示，由用户关闭时显式释放。
   */
  private async settle(conversationId: string, turn: TurnId): Promise<void> {
    let outcome: TurnOutcome;
    try {
      outcome = (await this.sessionRuntime.waitForTurn(asSessionId(conversationId), turn)).outcome;
    } catch (error) {
      console.warn("[answer] settle failed", {
        conversationId,
        error: error instanceof Error ? error.message : "unknown",
      });
      outcome = "failed";
    }
    try {
      if (outcome !== "failed") await this.release(asSessionId(conversationId));
    } finally {
      if (this.active.get(conversationId) === turn) this.active.delete(conversationId);
    }
  }

  private async release(session: SessionId): Promise<void> {
    await this.sessionRuntime.clear(session);
    await this.store.clear(session);
  }
}

function requestFor(step: StepStart): ConversationSendRequest {
  if (step.input === undefined) throw new Error(`Step 缺少输入：${step.stepId}`);
  return {
    text: step.input.text,
    images: step.input.images.map((image) => ({ ...image })),
  };
}
