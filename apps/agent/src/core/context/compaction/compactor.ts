/** 自动摘要压缩的运行时编排：状态推送、检查点保存和失败回退。 */
import { randomUUID } from "node:crypto";
import type {
  AgentDurableEvent,
  CompactionReason,
  ContextCompactionTrigger,
  ConversationSnapshot,
} from "@answra/shared";
import { latestCheckpoint } from "../../transcript/contextCheckpoint";
import type { ContextState } from "../../transcript/contextState";
import type { ConversationStore } from "../../transcript/store";
import { compactContext, type SummaryGeneratorInput } from "./compact";
import {
  markContextCompactionAborted,
  markContextCompactionFailed,
  markContextCompactionSucceeded,
  startContextCompaction,
} from "./lifecycle";
import type { CompactionSkipReason } from "./plan";
import type { CompactionView } from "./view";

export interface ContextSummaryRequest extends SummaryGeneratorInput {
  accessToken: string;
}

export type ContextSummaryGenerator = (input: ContextSummaryRequest) => Promise<string>;

/** 压缩生命周期事实；只携带 session journal 需要的最小身份，不复制上下文状态。 */
export interface ContextCompactionFact {
  conversationId: string;
  operationId: string;
  /** 只能是 compaction-*，避免观察口被拿去写其他 durable 事实。 */
  event: Extract<AgentDurableEvent, { type: `compaction-${string}` }>;
}

/**
 * 压缩事实观察口；由宿主接到 session journal。
 * 返回值不参与判定，失败时不阻断压缩，否则一次磁盘错误会让已经成功的摘要提交变成失败。
 */
export type ContextCompactionObserver = (fact: ContextCompactionFact) => Promise<unknown> | unknown;

export interface ContextCompactorOptions {
  store: ConversationStore;
  generate: ContextSummaryGenerator;
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
  /** 生命周期事实出口；自动与手动压缩共用同一条写入链。 */
  onCompaction?: ContextCompactionObserver;
  now?: () => Date;
}

const COMPACTION_FAILURE_LIMIT = 3;
const COMPACTION_RETRY_COOLDOWN_MS = 5 * 60_000;

export type ContextCompactionOutcome =
  | { status: "compacted"; summarizedMessages: number; retainedUserMessages: number }
  | { status: "skipped"; reason: CompactionSkipReason | "breaker-open" }
  | { status: "failed"; errorText: string }
  | { status: "aborted" };

export interface ContextCompactionRequest {
  conversationId: string;
  getAccessToken: () => Promise<string>;
  signal?: AbortSignal;
  trigger?: ContextCompactionTrigger;
  /** 抖动来源；缺省按 manual → manual、其余 → threshold 推导。 */
  reason?: CompactionReason;
  /** 手动压缩由 Scheduler 提供；自动压缩缺省时本地生成。 */
  operationId?: string;
  /** 摘要压缩触发点；由 ContextPreparation 按真实模型请求预算传入。 */
  triggerTokens: number;
  /** 清理后的最终模型请求 token；摘要触发与摘要渲染共享同一视图。 */
  finalRequestTokens: number;
  /** 最终模型请求已清理的 toolCallId；摘要渲染必须应用同一水印。 */
  prunedToolCallIds: readonly string[];
  /** 摘要输出上限；缺省使用 256k 窗口的基准值。 */
  summaryMaxTokens?: number;
  /** 手动压缩跳过触发点判断；只要 checkpoint 之后仍有消息就允许压缩。 */
  force?: boolean;
  /** 手动压缩的一次性摘要偏好；自动与超限兜底不传。 */
  instructions?: string;
  /** 手动操作可越过失败熔断；自动与超限兜底不得越过。 */
  bypassFailureBreaker?: boolean;
}

export class ContextCompactor {
  private readonly store: ConversationStore;
  private readonly generate: ContextSummaryGenerator;
  private readonly onSnapshot?: ContextCompactorOptions["onSnapshot"];
  private readonly onCompaction?: ContextCompactionObserver;
  private readonly now: () => Date;

  constructor({
    store,
    generate,
    onSnapshot,
    onCompaction,
    now = () => new Date(),
  }: ContextCompactorOptions) {
    this.store = store;
    this.generate = generate;
    this.onSnapshot = onSnapshot;
    this.onCompaction = onCompaction;
    this.now = now;
  }

  /** 执行摘要压缩；跳过、失败与取消都以显式结果返回。 */
  async prepare({
    conversationId,
    getAccessToken,
    signal,
    trigger = "auto",
    reason,
    operationId = randomUUID(),
    triggerTokens,
    finalRequestTokens,
    prunedToolCallIds,
    summaryMaxTokens,
    force,
    instructions,
    bypassFailureBreaker = false,
  }: ContextCompactionRequest): Promise<ContextCompactionOutcome> {
    const snapshot = await this.store.load(conversationId);
    const view: CompactionView = {
      messages: snapshot.messages,
      finalRequestTokens,
      prunedToolCallIds: new Set(prunedToolCallIds),
    };
    let state = (await this.store.loadContextState(conversationId)) ?? { checkpoints: [] };
    if (!bypassFailureBreaker && this.isFailureBreakerOpen(state)) {
      return { status: "skipped", reason: "breaker-open" };
    }
    // started 落库成功后才允许写终态：否则 journal 里会出现没有起点的 finished/failed，
    // 投影会拒绝整条会话。
    let startedRecorded = false;
    const reasonForEvent = reason ?? (trigger === "manual" ? "manual" : "threshold");
    try {
      const result = await compactContext({
        view,
        state,
        triggerTokens,
        force: force === true,
        ...(summaryMaxTokens === undefined ? {} : { summaryMaxTokens }),
        ...(instructions === undefined ? {} : { instructions }),
        signal,
        now: this.now,
        generate: async (input) =>
          this.generate({
            ...input,
            accessToken: await getAccessToken(),
          }),
        onStarted: async () => {
          state = {
            ...state,
            compaction: startContextCompaction({
              previous: state.compaction,
              trigger,
              now: this.now,
            }),
          };
          await this.persist(conversationId, state);
          startedRecorded = await this.observe({
            conversationId,
            operationId,
            event: { type: "compaction-started", trigger, reason: reasonForEvent },
          });
        },
      });
      if (result.status === "skipped") return result;
      const status = state.compaction;
      if (!status) throw new Error("上下文压缩状态未开启");
      const {
        compactionFailureCount: _failureCount,
        compactionRetryAt: _retryAt,
        ...successState
      } = result.state;
      const nextState: ContextState = {
        ...successState,
        compaction: markContextCompactionSucceeded(status, result.summarizedMessages, this.now),
      };
      await this.persist(conversationId, nextState);
      if (startedRecorded) {
        await this.observe({
          conversationId,
          operationId,
          event: {
            type: "compaction-finished",
            summarizedMessages: result.summarizedMessages,
            summary: latestCheckpoint(nextState)?.summary ?? "",
          },
        });
      }
      return {
        status: "compacted",
        summarizedMessages: result.summarizedMessages,
        retainedUserMessages: result.retainedUserMessages,
      };
    } catch (error) {
      if (isAbortError(error)) {
        await this.recordAborted(conversationId, state);
        if (startedRecorded) {
          await this.observe({
            conversationId,
            operationId,
            event: { type: "compaction-aborted" },
          });
        }
        return { status: "aborted" };
      }
      await this.recordFailure(conversationId, state, error, {
        countFailure: trigger !== "manual",
      });
      if (startedRecorded) {
        await this.observe({
          conversationId,
          operationId,
          event: { type: "compaction-failed", errorText: errorText(error) },
        });
      }
      return { status: "failed", errorText: errorText(error) };
    }
  }

  private isFailureBreakerOpen(state: ContextState): boolean {
    const failures = state.compactionFailureCount ?? 0;
    if (failures < COMPACTION_FAILURE_LIMIT || state.compactionRetryAt === undefined) return false;
    const retryAt = Date.parse(state.compactionRetryAt);
    return Number.isFinite(retryAt) && retryAt > this.now().getTime();
  }

  private async persist(conversationId: string, state: ContextState): Promise<void> {
    await this.store.saveContextState(conversationId, state);
    if (!this.onSnapshot) return;
    try {
      await this.onSnapshot(await this.store.load(conversationId));
    } catch (error) {
      console.error("[context-compaction] snapshot publish failed", {
        conversationId,
        error: errorText(error),
      });
    }
  }

  /** 事实写入失败只记录，不阻断压缩；返回是否已被宿主接受。 */
  private async observe(fact: ContextCompactionFact): Promise<boolean> {
    if (this.onCompaction === undefined) return true;
    try {
      await this.onCompaction(fact);
      return true;
    } catch (error) {
      console.error("[context-compaction] journal fact failed", {
        conversationId: fact.conversationId,
        type: fact.event.type,
        error: errorText(error),
      });
      return false;
    }
  }

  private async recordFailure(
    conversationId: string,
    state: ContextState,
    error: unknown,
    { countFailure }: { countFailure: boolean },
  ): Promise<void> {
    const status = state.compaction;
    if (status?.state !== "started") {
      console.warn("[context-compaction] failed before lifecycle started", {
        conversationId,
        error: errorText(error),
      });
      return;
    }
    const {
      compactionFailureCount: previousFailureCount,
      compactionRetryAt: previousRetryAt,
      ...base
    } = state;
    const failureCount = countFailure ? (previousFailureCount ?? 0) + 1 : previousFailureCount;
    const retryAt =
      countFailure && failureCount !== undefined && failureCount >= COMPACTION_FAILURE_LIMIT
        ? new Date(this.now().getTime() + COMPACTION_RETRY_COOLDOWN_MS).toISOString()
        : previousRetryAt;
    const failed = {
      ...base,
      ...(failureCount === undefined ? {} : { compactionFailureCount: failureCount }),
      ...(retryAt === undefined ? {} : { compactionRetryAt: retryAt }),
      compaction: markContextCompactionFailed(status, errorText(error), this.now),
    };
    try {
      await this.persist(conversationId, failed);
    } catch (persistError) {
      console.error("[context-compaction] failed to persist failure state", {
        conversationId,
        error: errorText(persistError),
      });
    }
  }

  private async recordAborted(conversationId: string, state: ContextState): Promise<void> {
    const status = state.compaction;
    if (status?.state !== "started") return;
    try {
      await this.persist(conversationId, {
        ...state,
        compaction: markContextCompactionAborted(status, this.now),
      });
    } catch (persistError) {
      console.error("[context-compaction] failed to persist aborted state", {
        conversationId,
        error: errorText(persistError),
      });
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "上下文压缩失败";
}
