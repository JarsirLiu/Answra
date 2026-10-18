import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  authRequiredError,
  type ConversationCapabilityEndpoint,
  type ConversationChange,
  type ConversationModelConfig,
  type ConversationSendRequest,
} from "@answra/shared";
import { type ModelMessage, streamText } from "ai";
import { ANSWER_PROFILE, CHAT_PROFILES, type ChatProfileId } from "./profiles";
import { type ConversationStore, createUserMessage, MemoryConversationStore } from "./store";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface ConversationRuntimeOptions {
  emit: (change: ConversationChange) => void;
  store?: ConversationStore;
  /**
   * 向宿主换取新的云端访问令牌；只在收到 401 时调用一次（单次重试）。
   * 缺省时不做重试，401 如实上报给上层。
   */
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
}

export class ConversationRuntime {
  private config?: ConversationModelConfig;
  private readonly runs = new Map<string, AbortController>();
  private readonly store: ConversationStore;
  private readonly unsubscribeStore: () => void;
  private readonly tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;

  constructor({
    emit,
    store = new MemoryConversationStore(),
    tokenProvider,
  }: ConversationRuntimeOptions) {
    this.store = store;
    this.tokenProvider = tokenProvider;
    this.unsubscribeStore = store.subscribe(emit);
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

  configure(config: ConversationModelConfig): void {
    for (const endpoint of [config.chat, config.answer]) validateEndpoint(endpoint);
    this.config = { chat: { ...config.chat }, answer: { ...config.answer } };
  }

  async sendChat(
    profileId: ChatProfileId,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    return this.startRun(
      conversationId,
      request,
      accessToken,
      profile.systemPrompt,
      profile.includeHistory,
      false,
      profile.injectTime ?? false,
    );
  }

  async runAnswer(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }> {
    await this.store.create(conversationId);
    if ((await this.store.load(conversationId)).activeRunId) throw new Error("当前回复尚未完成");
    await this.store.clear(conversationId);
    return this.startRun(
      conversationId,
      request,
      accessToken,
      ANSWER_PROFILE.systemPrompt,
      false,
      true,
      false,
    );
  }

  private async startRun(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
    systemPrompt: string,
    includeHistory: boolean,
    ephemeral: boolean,
    injectTime: boolean,
  ): Promise<{ runId: string }> {
    if (!this.config) throw new Error("云端模型服务尚未就绪");
    validateRequest(request);

    const runId = randomUUID();
    const controller = new AbortController();
    // 截图答题与对话是两项能力，端点与占位模型都可能不同：按运行所属的能力取。
    const endpoint = ephemeral ? this.config.answer : this.config.chat;
    await this.store.create(conversationId);
    await this.store.beginRun(conversationId, runId, createUserMessage(randomUUID(), request));
    this.runs.set(runId, controller);
    void this.execute(
      conversationId,
      runId,
      endpoint,
      accessToken,
      request,
      controller,
      systemPrompt,
      includeHistory,
      ephemeral,
      injectTime,
    );
    return { runId };
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.abort();
  }

  dispose(): void {
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
    this.unsubscribeStore();
  }

  get activeRunCount(): number {
    return this.runs.size;
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

  private async execute(
    conversationId: string,
    runId: string,
    endpoint: ConversationCapabilityEndpoint,
    accessToken: string,
    request: ConversationSendRequest,
    controller: AbortController,
    systemPrompt: string,
    includeHistory: boolean,
    ephemeral: boolean,
    injectTime: boolean,
  ): Promise<void> {
    const startedAt = Date.now();
    const chunkCounts: Record<string, number> = {};
    let started = false;
    let terminal = false;
    const emitChunk = async (chunk: import("ai").UIMessageChunk) => {
      chunkCounts[chunk.type] = (chunkCounts[chunk.type] ?? 0) + 1;
      if (Object.keys(chunkCounts).length === 1 && chunkCounts[chunk.type] === 1)
        console.info("[conversation][run] first chunk", { runId, type: chunk.type });
      await this.store.appendEvent({ conversationId, runId, chunk });
      if (chunk.type === "start") started = true;
      if (chunk.type === "finish" || chunk.type === "abort") terminal = true;
    };
    try {
      console.info("[conversation][run] started", {
        runId,
        model: endpoint.model,
        host: new URL(endpoint.baseUrl).host,
        imageCount: request.images.length,
        textLength: request.text.length,
      });
      const provider = createOpenAICompatible({
        name: "answra",
        baseURL: endpoint.baseUrl,
        apiKey: accessToken,
        fetch: this.createAuthorizedFetch(accessToken),
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
      const result = streamText({
        model: provider(endpoint.model),
        system: systemPrompt,
        messages,
        abortSignal: controller.signal,
        onError: ({ error }) => {
          console.error("[conversation][run] provider error", summarizeError(error));
        },
      });
      for await (const chunk of result.toUIMessageStream({
        generateMessageId: () => runId,
        onError: (error) => (error instanceof Error ? error.message.slice(0, 300) : "模型请求失败"),
      }))
        await emitChunk(chunk);
    } catch (error) {
      console.error("[conversation][run] failed", {
        runId,
        elapsedMs: Date.now() - startedAt,
        ...summarizeError(error),
      });
      if (!started) await emitChunk({ type: "start", messageId: runId });
      if (controller.signal.aborted) await emitChunk({ type: "abort" });
      else {
        await emitChunk({
          type: "error",
          errorText: error instanceof Error ? error.message : "模型请求失败",
        });
        await emitChunk({ type: "finish", finishReason: "error" });
      }
    } finally {
      if (!terminal) await emitChunk({ type: "finish" });
      await this.store.finishRun(
        conversationId,
        runId,
        controller.signal.aborted ? "interrupted" : "complete",
      );
      if (ephemeral) await this.store.clear(conversationId);
      console.info("[conversation][run] finished", {
        runId,
        elapsedMs: Date.now() - startedAt,
        chunkCounts,
        cancelled: controller.signal.aborted,
      });
      this.runs.delete(runId);
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

function validateRequest(request: ConversationSendRequest): void {
  if (typeof request.text !== "string" || request.text.length > 32_000)
    throw new Error("消息内容无效或过长");
  if (!Array.isArray(request.images) || request.images.length > 8)
    throw new Error("单次最多发送 8 张图片");
  for (const image of request.images) {
    if (
      typeof image.name !== "string" ||
      image.name.length > 256 ||
      typeof image.dataUrl !== "string"
    )
      throw new Error("图片附件无效");
    const parsed = parseDataUrl(image.dataUrl);
    if (parsed.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 8 MB");
  }
}

function parseDataUrl(value: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match?.[1] || !match[2] || !ALLOWED_IMAGE_TYPES.has(match[1].toLowerCase()))
    throw new Error("图片格式仅支持 PNG、JPEG、WebP 或 GIF");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES)
    throw new Error("单张图片不能超过 8 MB");
  return { mediaType: match[1].toLowerCase(), bytes: new Uint8Array(bytes) };
}

function formatLocalTime(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const tz = get("timeZoneName");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}${
    tz ? ` (${tz})` : ""
  }`;
}

function buildTimeReminder(): string {
  return `<system-reminder>\n# currentDate\nCurrent date and time is ${formatLocalTime()}.\n</system-reminder>`;
}
