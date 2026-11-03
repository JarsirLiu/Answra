import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  authRequiredError,
  type ConversationCapabilityEndpoint,
  type ConversationChange,
  type ConversationModelConfig,
  type ConversationSendRequest,
} from "@answra/shared";
import type { AgentStreamEvent, RunOutcome } from "@answra/shared/schema";
import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { RunRegistry } from "../core/run/registry";
import { normalizeStreamChunk } from "../core/streamEvents";
import { ANSWER_PROFILE } from "./answerProfile";
import { parseDataUrl, validateRequest } from "./requestContent";
import { type ConversationStore, createUserMessage, MemoryConversationStore } from "./store";
import { buildTimeReminder } from "./timeReminder";
import type { ConversationToolId } from "./tools/types";

/** 答题需要稳定但保留少量多样性；通用对话不覆盖提供商默认值。 */
const ANSWER_TEMPERATURE = 0.3;
/** 答题优先降低内部推理开销；不支持的 OpenAI-compatible 端点通常会忽略。 */
const ANSWER_REASONING_EFFORT = "low";

/** 生成 assistant 回合所需的领域策略；各领域自持 profile，不借用对话配置。 */
export interface ReplyProfile {
  systemPrompt: string;
  includeHistory: boolean;
  injectTime?: boolean;
  tools: readonly ConversationToolId[];
}

export interface ConversationRuntimeOptions {
  emit: (change: ConversationChange) => void;
  store?: ConversationStore;
  /** Tool construction is owned by the worker composition, so release profiles can omit domains. */
  createTools: (
    authorizedIds: readonly ConversationToolId[],
    context: { workspaceRoot: string | null; signal: AbortSignal },
  ) => ToolSet | undefined;
  /**
   * 向宿主换取新的云端访问令牌；只在收到 401 时调用一次（单次重试）。
   * 缺省时不做重试，401 如实上报给上层。
   */
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
}

export class ConversationRuntime {
  private config?: ConversationModelConfig;
  private readonly runs = new RunRegistry();
  private readonly store: ConversationStore;
  private readonly unsubscribeStore: () => void;
  private readonly tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  private readonly createTools: ConversationRuntimeOptions["createTools"];
  private workspaceRoot: string | null = null;

  constructor({
    emit,
    store = new MemoryConversationStore(),
    createTools,
    tokenProvider,
  }: ConversationRuntimeOptions) {
    this.store = store;
    this.tokenProvider = tokenProvider;
    this.createTools = createTools;
    this.unsubscribeStore = store.subscribe(emit);
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  getSnapshot(conversationId: string) {
    return this.store.load(conversationId);
  }

  readEventsAfter(conversationId: string, revision: number) {
    return this.store.readAfter(conversationId, revision);
  }

  async createConversation(conversationId: string) {
    return this.store.create(conversationId);
  }

  /**
   * 用户显式清空会话消息。仅空闲会话生效（store 内守卫）；无此会话时视为无事可清。
   * 发布的 snapshot change 是唯一归零信号：订阅方与 readEvents 游标都依赖它。
   */
  async clearConversation(conversationId: string): Promise<void> {
    await this.store.clear(conversationId);
  }

  async appendUserMessage(conversationId: string, text: string): Promise<void> {
    if (typeof text !== "string" || !text.trim() || text.length > 32_000)
      throw new Error("消息内容无效或过长");
    await this.store.appendUserMessage(
      conversationId,
      createUserMessage(randomUUID(), { text: text.trim(), images: [] }),
    );
  }

  configure(config: ConversationModelConfig): void {
    for (const endpoint of [config.chat, config.answer]) validateEndpoint(endpoint);
    this.config = { chat: { ...config.chat }, answer: { ...config.answer } };
  }

  async runAnswer(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }> {
    return this.startRun(
      conversationId,
      request,
      accessToken,
      ANSWER_PROFILE.systemPrompt,
      false,
      true,
      false,
      [],
    );
  }

  protected async startRun(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
    systemPrompt: string,
    includeHistory: boolean,
    ephemeral: boolean,
    injectTime: boolean,
    authorizedTools: readonly ConversationToolId[],
  ): Promise<{ runId: string }> {
    if (!this.config) throw new Error("云端模型服务尚未就绪");
    validateRequest(request);

    const runId = randomUUID();
    const controller = new AbortController();
    const workspaceRoot = this.workspaceRoot;
    // 截图答题与对话是两项能力，端点与占位模型都可能不同：按运行所属的能力取。
    const endpoint = ephemeral ? this.config.answer : this.config.chat;
    await this.store.create(conversationId);
    const userMessage = createUserMessage(randomUUID(), request);
    // 一次性答题的认领（并发拒绝 + 清残留 + 占位）是仓储内的原子状态迁移；
    // 多轮对话沿用 beginRun 的原子守卫。
    if (ephemeral) await this.store.beginEphemeralRun(conversationId, runId, userMessage);
    else await this.store.beginRun(conversationId, runId, userMessage);
    this.trackRun(runId, controller);
    void this.execute(
      conversationId,
      runId,
      endpoint,
      async () => accessToken,
      request,
      controller,
      systemPrompt,
      includeHistory,
      ephemeral,
      injectTime,
      authorizedTools,
      workspaceRoot,
    );
    return { runId };
  }

  /**
   * Replies to the last complete user message with a caller-owned profile.
   * The user message is already in the store, so this claims only the assistant turn.
   */
  async replyToLastUserWithProfile(
    profile: ReplyProfile,
    conversationId: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ runId: string }> {
    return this.startReplyRun(
      conversationId,
      getAccessToken,
      profile.systemPrompt,
      profile.includeHistory,
      profile.injectTime ?? false,
      profile.tools,
    );
  }

  /**
   * Replies to the last complete user message. The user message is already in the
   * store, so this claims only the assistant turn and never duplicates the input.
   */
  protected async startReplyRun(
    conversationId: string,
    getAccessToken: () => Promise<string>,
    systemPrompt: string,
    includeHistory: boolean,
    injectTime: boolean,
    authorizedTools: readonly ConversationToolId[],
  ): Promise<{ runId: string }> {
    if (!this.config) throw new Error("云端模型服务尚未就绪");

    const runId = randomUUID();
    const controller = new AbortController();
    const workspaceRoot = this.workspaceRoot;
    const endpoint = this.config.chat;
    // 认领与取最后一条 user 消息必须在同一步完成：先读快照再认领会让并发
    // 追加的用户消息与本次请求错位，尤其会影响 includeHistory=false 的 profile。
    const target = await this.store.beginReplyRun(conversationId, runId);
    const request: ConversationSendRequest = { text: target.text, images: target.images };
    this.trackRun(runId, controller);
    // 令牌在 run 认领后、execute 内获取：换取失败也走 start/error/failed，
    // 用户能在消息流里看到这一轮回复失败，而不是只收到一个已启动却无下文的 run。
    void this.execute(
      conversationId,
      runId,
      endpoint,
      getAccessToken,
      request,
      controller,
      systemPrompt,
      includeHistory,
      false,
      injectTime,
      authorizedTools,
      workspaceRoot,
    );
    return { runId };
  }

  private trackRun(runId: string, controller: AbortController): void {
    this.runs.register(runId, controller);
  }

  cancel(runId: string): void {
    this.runs.cancel(runId);
  }

  /** Completes after the run's `finishRun` and cleanup, whether it succeeded or was interrupted. */
  waitForRun(runId: string): Promise<void> {
    return this.runs.wait(runId);
  }

  dispose(): void {
    this.runs.abortAll();
    this.unsubscribeStore();
  }

  get activeRunCount(): number {
    return this.runs.activeCount;
  }

  /**
   * 带令牌的 fetch：正常路径直接用本次运行注入的令牌（不额外往返宿主）。
   *
   * 401 的两种来源都必须收敛到同一个用户可见结果：令牌在途过期 → 向宿主换一次新令牌并
   * **单次**重放；仍然 401（未登录、会话已失效）→ 抛出与 main 侧门禁同一个失败码
   * `auth-required`，渲染层据此提示「去设置里登录」，而不是把网关原始文案抛给用户。
   * 其他非 2xx（额度、限流、上游）如实交回 SDK，由 SDK 的错误通道展示服务端消息，不重试。
   */
  private createAuthorizedFetch(accessToken: string): typeof fetch {
    type FetchInput = Parameters<typeof fetch>[0];
    type FetchInit = Parameters<typeof fetch>[1];
    const send = (token: string, input: FetchInput, init?: FetchInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    return async (input: FetchInput, init?: FetchInit) => {
      const response = await send(accessToken, input, init);
      if (response.status !== 401) return response;
      if (this.tokenProvider) {
        let refreshed: string | undefined;
        try {
          refreshed = await this.tokenProvider({ forceRefresh: true });
        } catch (error) {
          console.warn("[conversation][run] 令牌刷新失败", summarizeError(error));
        }
        if (refreshed && refreshed !== accessToken) {
          const retried = await send(refreshed, input, init);
          if (retried.status !== 401) return retried;
        }
      }
      throw authRequiredError();
    };
  }

  /**
   * 本地端点的 fetch：只用本机保存的 API Key，不触发登录、不刷新令牌。
   *
   * Key 为空时显式删掉 Authorization 头（SDK 会按 apiKey 参数自动加），让「无 Key
   * 也能连」的本地服务保持原样；401 等错误如实交回 SDK，由错误通道展示服务端消息。
   */
  private createLocalFetch(apiKey: string): typeof fetch {
    return (input, init) => {
      const headers = new Headers(init?.headers);
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      else headers.delete("Authorization");
      return fetch(input, { ...init, headers });
    };
  }

  private async execute(
    conversationId: string,
    runId: string,
    endpoint: ConversationCapabilityEndpoint,
    getAccessToken: () => Promise<string>,
    request: ConversationSendRequest,
    controller: AbortController,
    systemPrompt: string,
    includeHistory: boolean,
    ephemeral: boolean,
    injectTime: boolean,
    authorizedTools: readonly ConversationToolId[],
    workspaceRoot: string | null,
  ): Promise<void> {
    const startedAt = Date.now();
    const chunkCounts: Record<string, number> = {};
    let started = false;
    let failed = false;
    const emitStream = async (stream: AgentStreamEvent) => {
      chunkCounts[stream.type] = (chunkCounts[stream.type] ?? 0) + 1;
      if (Object.keys(chunkCounts).length === 1 && chunkCounts[stream.type] === 1)
        console.info("[conversation][run] first chunk", { runId, type: stream.type });
      await this.store.appendEvent({ conversationId, runId, stream });
      if (stream.type === "start") started = true;
      if (stream.type === "error") failed = true;
    };
    try {
      const accessToken = await getAccessToken();
      console.info("[conversation][run] started", {
        runId,
        model: endpoint.model,
        host: new URL(endpoint.baseUrl).host,
        imageCount: request.images.length,
        textLength: request.text.length,
      });
      const local = endpoint.auth === "local";
      const provider = createOpenAICompatible({
        name: "answra",
        baseURL: endpoint.baseUrl,
        apiKey: accessToken || "local",
        fetch: local ? this.createLocalFetch(accessToken) : this.createAuthorizedFetch(accessToken),
      });
      const content = [
        ...(request.text.trim() ? [{ type: "text" as const, text: request.text }] : []),
        ...request.images.map((image) => {
          const parsed = parseDataUrl(image.dataUrl);
          return { type: "image" as const, image: parsed.bytes, mediaType: parsed.mediaType };
        }),
      ];
      const messages: ModelMessage[] = includeHistory
        ? (await this.store.load(conversationId)).messages
            .filter((message) => message.status !== "streaming")
            .map((message) =>
              message.role === "assistant"
                ? { role: "assistant", content: message.text }
                : {
                    role: "user",
                    content: [
                      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
                      ...message.images.map((image) => {
                        const parsed = parseDataUrl(image.dataUrl);
                        return {
                          type: "image" as const,
                          image: parsed.bytes,
                          mediaType: parsed.mediaType,
                        };
                      }),
                    ],
                  },
            )
        : [{ role: "user", content }];
      if (injectTime) {
        const last = messages[messages.length - 1];
        const reminder = buildTimeReminder();
        if (last && last.role === "user") {
          const prev = last.content;
          last.content = [
            ...(typeof prev === "string"
              ? [{ type: "text" as const, text: prev }]
              : Array.isArray(prev)
                ? prev
                : []),
            { type: "text" as const, text: reminder },
          ];
        } else {
          messages.push({ role: "user", content: [{ type: "text" as const, text: reminder }] });
        }
      }
      const tools = authorizedTools.length
        ? this.createTools(authorizedTools, {
            workspaceRoot,
            signal: controller.signal,
          })
        : undefined;
      const result = streamText({
        model: provider(endpoint.model),
        system: systemPrompt,
        messages,
        abortSignal: controller.signal,
        ...(ephemeral
          ? {
              temperature: ANSWER_TEMPERATURE,
              providerOptions: {
                openaiCompatible: { reasoningEffort: ANSWER_REASONING_EFFORT },
              },
            }
          : {}),
        ...(tools ? { tools, stopWhen: stepCountIs(6) } : {}),
        onError: ({ error }) => {
          console.error("[conversation][run] provider error", summarizeError(error));
        },
      });
      for await (const chunk of result.toUIMessageStream({
        generateMessageId: () => runId,
        onError: (error) => (error instanceof Error ? error.message.slice(0, 300) : "模型请求失败"),
      })) {
        const stream = normalizeStreamChunk(chunk);
        if (stream) await emitStream(stream);
      }
    } catch (error) {
      console.error("[conversation][run] failed", {
        runId,
        elapsedMs: Date.now() - startedAt,
        ...summarizeError(error),
      });
      if (!started) await emitStream({ type: "start" });
      if (!controller.signal.aborted) {
        await emitStream({
          type: "error",
          errorText: error instanceof Error ? error.message : "模型请求失败",
        });
        failed = true;
      }
    } finally {
      const outcome: RunOutcome = controller.signal.aborted
        ? "aborted"
        : failed
          ? "failed"
          : "completed";
      await this.store.finishRun(conversationId, runId, outcome);
      // 失败轮是用户可见结果，保留消息与 journal 供详情面板读取；成功/取消轮
      // 仍即时释放。下一轮 beginEphemeralRun 会清掉上一次的失败残留。
      if (ephemeral && !failed) await this.store.clear(conversationId);
      console.info("[conversation][run] finished", {
        runId,
        elapsedMs: Date.now() - startedAt,
        chunkCounts,
        cancelled: controller.signal.aborted,
      });
      this.runs.finish(runId);
    }
  }
}

function validateEndpoint(endpoint: ConversationCapabilityEndpoint): void {
  const url = new URL(endpoint.baseUrl);
  if (
    !(url.protocol === "http:" || url.protocol === "https:") ||
    url.username ||
    url.password ||
    !endpoint.model.trim()
  ) {
    throw new Error("云端模型端点无效");
  }
}

function summarizeError(error: unknown): { errorName: string; error: string; statusCode?: number } {
  const value = error as { name?: unknown; message?: unknown; statusCode?: unknown } | null;
  const statusCode = typeof value?.statusCode === "number" ? value.statusCode : undefined;
  return {
    errorName: typeof value?.name === "string" ? value.name : "Error",
    error: typeof value?.message === "string" ? value.message.slice(0, 300) : "模型请求失败",
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}
