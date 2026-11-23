/** 一次 provider 请求与工具执行：模型流事件经 recorder 结算成条目；不改变 Turn 状态。 */
import type { AgentStreamEvent } from "@answra/shared/schema";
import type {
  StepEventRecorder,
  StepEventSink,
  StepExecutor,
  StepResult,
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
  TurnRunContext,
} from "./contracts";
import { sessionErrorText } from "./sessionErrorText";

export interface SessionStepExecutorOptions {
  /** 唯一事件漏斗：实现先写内存视图，再结算条目；不落库的增量只走 live 帧。 */
  recorder: StepEventRecorder;
  runner: StepRunner;
  /** step 结算观察口：usage 锚点与 Turn 统计；不写事实。 */
  onStepFinished?: (step: StepStart, result: StepRunnerResult) => void | Promise<void>;
}

export class SessionStepExecutor implements StepExecutor {
  private readonly recorder: StepEventRecorder;
  private readonly runner: StepRunner;
  private readonly onStepFinished?: SessionStepExecutorOptions["onStepFinished"];

  constructor({ recorder, runner, onStepFinished }: SessionStepExecutorOptions) {
    this.recorder = recorder;
    this.runner = runner;
    this.onStepFinished = onStepFinished;
  }

  async run(step: StepStart, runtime: TurnRunContext, signal: AbortSignal): Promise<StepResult> {
    if (signal.aborted) return { stepId: step.stepId, outcome: "aborted" };

    const context: StepRunContext = {
      events: new RecorderStepEventSink(this.recorder, step),
      runtime,
    };
    let result = await this.executeRunner(step, context, signal);
    try {
      await context.events.flush();
    } catch (error) {
      result = { outcome: "failed", errorText: sessionErrorText(error) };
    }
    await this.onStepFinished?.(step, result);
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
}

/** 串行写入：每个事件先落内存视图，再把结算条目追加到存储；失败延迟到 flush 统一报告。 */
class RecorderStepEventSink implements StepEventSink {
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly recorder: StepEventRecorder,
    private readonly step: StepStart,
  ) {}

  append(event: AgentStreamEvent): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.failure !== undefined) return;
      try {
        await this.recorder.append(this.step, event);
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
