/** 一次 provider 请求与工具执行：独占 step-* 与 usage 事件，模型流事件经 sink 写入；不改变 Turn 状态。 */
import type { AgentEvent, AgentStreamEvent } from "@answra/shared/schema";
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

export interface SessionStepExecutorOptions {
  journal: SessionJournal;
  runner: StepRunner;
}

export class SessionStepExecutor implements StepExecutor {
  private readonly journal: SessionJournal;
  private readonly runner: StepRunner;

  constructor({ journal, runner }: SessionStepExecutorOptions) {
    this.journal = journal;
    this.runner = runner;
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
      events: new JournalStepEventSink(this.journal, step, metadata),
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
    event: AgentEvent,
    metadata: SessionJournalAppend,
  ): Promise<void> {
    await this.journal.append(step.sessionId, event, metadata);
  }
}

/** 串行写入模型流事件；失败延迟到 flush 统一报告，避免丢失 step 终态。 */
class JournalStepEventSink implements StepEventSink {
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly journal: SessionJournal,
    private readonly step: StepStart,
    private readonly metadata: SessionJournalAppend,
  ) {}

  append(event: AgentStreamEvent): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.failure !== undefined) return;
      try {
        await this.journal.append(this.step.sessionId, event, this.metadata);
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
