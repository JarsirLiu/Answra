/** 一次 provider 请求与工具执行：独占 step-* 与 usage 事件，模型流事件经 sink 写入；不改变 Turn 状态。 */
import {
  type AgentDurableEvent,
  type AgentStreamEvent,
  agentDurableEventSchema,
} from "@answra/shared/schema";
import type {
  StepEventSink,
  StepExecutor,
  StepResult,
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
  TurnRunContext,
} from "./contracts";
import type { SessionJournal, SessionJournalAppend } from "./journal";
import { sessionErrorText } from "./sessionErrorText";

export type StepStreamObserver = (step: StepStart, event: AgentStreamEvent) => void | Promise<void>;

export interface SessionStepExecutorOptions {
  journal: SessionJournal;
  runner: StepRunner;
  /**
   * 实时流出口：接收本轮 step 的全部模型事件，包括不落 journal 的 live-only 增量。
   * 宿主须自行过滤增量与 durable 事件，避免同一事件被重复投影。
   */
  onStreamEvent?: StepStreamObserver;
}

export class SessionStepExecutor implements StepExecutor {
  private readonly journal: SessionJournal;
  private readonly runner: StepRunner;
  private readonly onStreamEvent?: StepStreamObserver;

  constructor({ journal, runner, onStreamEvent }: SessionStepExecutorOptions) {
    this.journal = journal;
    this.runner = runner;
    this.onStreamEvent = onStreamEvent;
  }

  async run(step: StepStart, runtime: TurnRunContext, signal: AbortSignal): Promise<StepResult> {
    if (signal.aborted) return { stepId: step.stepId, outcome: "aborted" };

    const metadata = this.metadata(step);
    await this.append(
      step,
      {
        type: "step-started",
        stepId: step.stepId,
        index: step.index,
        agentId: step.agentId,
        ...(step.modelId === undefined ? {} : { modelId: step.modelId }),
      },
      metadata,
    );

    const context: StepRunContext = {
      events: new JournalStepEventSink(this.journal, step, metadata, this.onStreamEvent),
      runtime,
    };
    let result = await this.executeRunner(step, context, signal);
    try {
      await context.events.flush();
    } catch (error) {
      result = { outcome: "failed", errorText: sessionErrorText(error) };
    }
    await this.append(
      step,
      {
        type: "step-finished",
        stepId: step.stepId,
        index: step.index,
        state: result.outcome,
        ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.errorText === undefined ? {} : { errorText: result.errorText }),
      },
      metadata,
    );

    if (result.usage?.inputTokens !== undefined) {
      await this.append(
        step,
        { type: "context-usage-changed", usedTokens: result.usage.inputTokens },
        metadata,
      );
    }

    return { ...result, stepId: step.stepId };
  }

  private async executeRunner(
    step: StepStart,
    context: StepRunContext,
    signal: AbortSignal,
  ): Promise<StepRunnerResult> {
    try {
      return await this.runner.run(step, context, signal);
    } catch (error) {
      if (signal.aborted) return { outcome: "aborted" };
      return { outcome: "failed", errorText: sessionErrorText(error) };
    }
  }

  private metadata(step: StepStart): SessionJournalAppend {
    return {
      turnId: step.turnId,
      stepId: step.stepId,
      ...(step.messageId === undefined ? {} : { messageId: step.messageId }),
    };
  }

  private async append(
    step: StepStart,
    event: AgentDurableEvent,
    metadata: SessionJournalAppend,
  ): Promise<void> {
    await this.journal.append(step.sessionId, event, metadata);
  }
}

/** 串行写入 durable 模型事件并转发实时流；高频增量不落 journal，失败延迟到 flush 统一报告。 */
class JournalStepEventSink implements StepEventSink {
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly journal: SessionJournal,
    private readonly step: StepStart,
    private readonly metadata: SessionJournalAppend,
    private readonly observer?: StepStreamObserver,
  ) {}

  append(event: AgentStreamEvent): Promise<void> {
    const durable = agentDurableEventSchema.safeParse(event);
    const observer = this.observer;
    if (!durable.success && observer === undefined) return Promise.resolve();
    this.chain = this.chain.then(async () => {
      if (this.failure !== undefined) return;
      try {
        if (observer !== undefined) await observer(this.step, event);
        if (durable.success) {
          await this.journal.append(this.step.sessionId, durable.data, this.metadata);
        }
      } catch (error) {
        this.failure = error;
      }
    });
    return this.chain;
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.failure !== undefined) throw this.failure;
  }
}
