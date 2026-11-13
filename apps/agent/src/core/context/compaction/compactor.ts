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

export interface ContextCompactionRequest {
  conversationId: string;
  getAccessToken: () => Promise<string>;
  signal?: AbortSignal;
  trigger?: ContextCompactionTrigger;
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

  /** 在发起 run 之前压缩旧上下文；无需压缩或压缩失败时返回 false，不阻断本轮。 */
  async prepare({
    conversationId,
    getAccessToken,
    signal,
    trigger = "auto",
  }: ContextCompactionRequest): Promise<boolean> {
    const snapshot = await this.store.load(conversationId);
    let state = (await this.store.loadContextState(conversationId)) ?? { checkpoints: [] };
    try {
      const result = await compactContext({
        messages: snapshot.messages,
        state,
        profile: this.profile,
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
      if (!status) throw new Error("上下文压缩状态未开始");
      await this.persist(conversationId, {
        ...result.state,
        compaction: markContextCompactionSucceeded(status, result.summarizedMessages, this.now),
      });
      return true;
    } catch (error) {
      await this.recordFailure(conversationId, state, error);
      return false;
    }
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
    const failed = {
      ...state,
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "上下文压缩失败";
}
