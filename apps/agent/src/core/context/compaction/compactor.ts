/** 自动摘要压缩的运行时编排：状态推送、检查点保存和失败回退。 */
import type { ContextCompactionTrigger, ConversationSnapshot } from "@answra/shared";
import type { ContextState } from "../../transcript/contextState";
import type { ConversationStore } from "../../transcript/store";
import { compactContext, type SummaryGeneratorInput } from "./compact";
import {
  markContextCompactionFailed,
  markContextCompactionSucceeded,
  startContextCompaction,
} from "./lifecycle";
import type { CompactionProfile } from "./profile";

export interface ContextSummaryRequest extends SummaryGeneratorInput {
  accessToken: string;
}

export type ContextSummaryGenerator = (input: ContextSummaryRequest) => Promise<string>;

export interface ContextCompactorOptions {
  store: ConversationStore;
  profile: CompactionProfile;
  generate: ContextSummaryGenerator;
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
  now?: () => Date;
}

const COMPACTION_FAILURE_LIMIT = 3;
const COMPACTION_RETRY_COOLDOWN_MS = 5 * 60_000;

export interface ContextCompactionRequest {
  conversationId: string;
  getAccessToken: () => Promise<string>;
  signal?: AbortSignal;
  trigger?: ContextCompactionTrigger;
  /** 摘要压缩触发点；由 ContextPreparation 按真实模型请求预算传入。 */
  triggerTokens: number;
  /** 最终模型请求的保守 token 估算；缺省时退回 transcript 估算。 */
  contextTokens?: number;
  /** 手动压缩跳过触发点判断，但仍保留最少消息数与保留尾段约束。 */
  force?: boolean;
  /** 手动操作可越过失败熔断；自动与超限兜底不得越过。 */
  bypassFailureBreaker?: boolean;
}

export class ContextCompactor {
  private readonly store: ConversationStore;
  private readonly profile: CompactionProfile;
  private readonly generate: ContextSummaryGenerator;
  private readonly onSnapshot?: ContextCompactorOptions["onSnapshot"];
  private readonly now: () => Date;

  constructor({
    store,
    profile,
    generate,
    onSnapshot,
    now = () => new Date(),
  }: ContextCompactorOptions) {
    this.store = store;
    this.profile = profile;
    this.generate = generate;
    this.onSnapshot = onSnapshot;
    this.now = now;
  }

  /** 执行摘要压缩；无需压缩或压缩失败时返回 false。 */
  async prepare({
    conversationId,
    getAccessToken,
    signal,
    trigger = "auto",
    triggerTokens,
    contextTokens,
    force,
    bypassFailureBreaker = false,
  }: ContextCompactionRequest): Promise<boolean> {
    const snapshot = await this.store.load(conversationId);
    let state = (await this.store.loadContextState(conversationId)) ?? { checkpoints: [] };
    if (!bypassFailureBreaker && this.isFailureBreakerOpen(state)) return false;
    try {
      const result = await compactContext({
        messages: snapshot.messages,
        state,
        profile: this.profile,
        triggerTokens,
        force: force === true,
        ...(contextTokens === undefined ? {} : { contextTokens }),
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
        },
      });
      if (!result) return false;
      const status = state.compaction;
      if (!status) throw new Error("上下文压缩状态未开启");
      const {
        compactionFailureCount: _failureCount,
        compactionRetryAt: _retryAt,
        ...successState
      } = result.state;
      await this.persist(conversationId, {
        ...successState,
        compaction: markContextCompactionSucceeded(status, result.summarizedMessages, this.now),
      });
      return true;
    } catch (error) {
      await this.recordFailure(conversationId, state, error);
      return false;
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

  private async recordFailure(
    conversationId: string,
    state: ContextState,
    error: unknown,
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
    const aborted = isAbortError(error);
    const failureCount = aborted ? previousFailureCount : (previousFailureCount ?? 0) + 1;
    const retryAt = aborted
      ? previousRetryAt
      : failureCount !== undefined && failureCount >= COMPACTION_FAILURE_LIMIT
        ? new Date(this.now().getTime() + COMPACTION_RETRY_COOLDOWN_MS).toISOString()
        : undefined;
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
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "上下文压缩失败";
}
