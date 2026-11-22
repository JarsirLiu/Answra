/**
 * durable/live 帧的进程内广播口。
 *
 * 只把已产生的事实与增量推给订阅者：不保存历史、不分配游标、不判断状态。
 * 订阅者异常不得影响事实写入，因此每次广播独立兜住错误。
 */
import {
  type AgentStreamEvent,
  agentLiveOnlyEventSchema,
  type LiveFrame,
  type SessionFrame,
} from "@answra/shared/schema";
import type { StepStart } from "./contracts";

export interface SessionFrameListener {
  onFrame?(frame: SessionFrame): void;
  onLiveFrame?(frame: LiveFrame): void;
}

export interface SessionFrameBusOptions {
  /** 默认只记日志；宿主可注入自己的告警通道。 */
  onListenerError?: (error: unknown) => void;
}

export class SessionFrameBus {
  private readonly listeners = new Set<SessionFrameListener>();
  private readonly onListenerError: (error: unknown) => void;

  constructor({ onListenerError }: SessionFrameBusOptions = {}) {
    this.onListenerError =
      onListenerError ??
      ((error: unknown) => console.warn("[session-frame] listener failed", error));
  }

  /** 广播一条 durable 事实帧；不做校验、不重排。 */
  publish(frame: SessionFrame): void {
    for (const listener of this.listeners) {
      try {
        listener.onFrame?.(frame);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  /** 广播一条 live 增量帧；允许丢失，不进入任何持久化路径。 */
  publishLive(frame: LiveFrame): void {
    for (const listener of this.listeners) {
      try {
        listener.onLiveFrame?.(frame);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  subscribe(listener: SessionFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * 把 step 的模型流事件转成 live 帧。
 *
 * 非 live-only 事件返回 `undefined`：durable 事实只能走 `publish`，不得混入 live 通道。
 */
export function toLiveFrame(step: StepStart, event: AgentStreamEvent): LiveFrame | undefined {
  const parsed = agentLiveOnlyEventSchema.safeParse(event);
  if (!parsed.success) return undefined;
  return {
    sessionId: step.sessionId,
    messageId: step.messageId,
    stepId: step.stepId,
    event: parsed.data,
  };
}
