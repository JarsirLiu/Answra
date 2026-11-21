/** 一次 provider 请求与工具执行：只写 step-* 与 usage 事件，不改变 Turn 状态。 */
import type { AgentEvent } from "@answra/shared/schema";
import type {
  StepExecutor,
  StepResult,
  StepRunner,
  StepRunnerResult,
  StepStart,
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

  async run(step: StepStart, signal: AbortSignal): Promise<StepResult> {
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

    const result = await this.executeRunner(step, signal);
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

  private async executeRunner(step: StepStart, signal: AbortSignal): Promise<StepRunnerResult> {
    try {
      return await this.runner.run(step, signal);
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
