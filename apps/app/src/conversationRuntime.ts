import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  ConversationChange,
  ConversationModelConfig,
  ConversationSendRequest,
} from "@answra/shared";
import { streamText } from "ai";
import {
  type ConversationStore,
  createUserMessage,
  MemoryConversationStore,
} from "./conversationStore";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const ANSWER_SYSTEM_PROMPT = [
  "你是笔试答题助手。用户发来题目截图，你只输出答案本身，不输出分析过程。",
  "回复规范（所有题型统一）：",
  '- 第一行以「答案：」开头直接给答案。',
  "- 选择题只写选项字母与选项内容；判断题写「正确」或「错误」；填空题只写空内内容；计算、编程题给最终结果，可另起一行列出最多 3 条关键步骤。",
  "- 答案之后最多补一句必要理由；没有把握时明确写「不确定」。",
  "- 禁止复述题目、寒暄、总结收尾，禁止使用 Markdown 标题、加粗、列表符号，禁止多段展开。",
  '- 截图含多道题时按「第N题：答案」逐行作答，同样不写分析。',
  "- 截图没有可识别题目时只回复「未识别到题目」。",
].join("\n");

export class ConversationRuntime {
  private config?: ConversationModelConfig;
  private readonly runs = new Map<string, AbortController>();
  private readonly store: ConversationStore;
  private readonly unsubscribeStore: () => void;

  constructor(
    emit: (change: ConversationChange) => void,
    store: ConversationStore = new MemoryConversationStore(),
  ) {
    this.store = store;
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
    const url = new URL(config.baseUrl);
    if (
      !(url.protocol === "http:" || url.protocol === "https:") ||
      url.username ||
      url.password ||
      !config.model.trim()
    ) {
      throw new Error("模型服务配置无效");
    }
    this.config = { ...config };
  }

  async send(conversationId: string, request: ConversationSendRequest): Promise<{ runId: string }> {
    if (!this.config) throw new Error("请先在设置中配置模型服务");
    validateRequest(request);

    const runId = randomUUID();
    const controller = new AbortController();
    const config = this.config;
    await this.store.create(conversationId);
    await this.store.beginRun(conversationId, runId, createUserMessage(randomUUID(), request));
    this.runs.set(runId, controller);
    void this.execute(conversationId, runId, config, request, controller);
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

  private async execute(
    conversationId: string,
    runId: string,
    config: ConversationModelConfig,
    request: ConversationSendRequest,
    controller: AbortController,
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
        model: config.model,
        host: new URL(config.baseUrl).host,
        imageCount: request.images.length,
        textLength: request.text.length,
      });
      const provider = createOpenAICompatible({
        name: "answra",
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      });
      const content = [
        ...(request.text.trim() ? [{ type: "text" as const, text: request.text }] : []),
        ...request.images.map((image) => {
          const parsed = parseDataUrl(image.dataUrl);
          return { type: "image" as const, image: parsed.bytes, mediaType: parsed.mediaType };
        }),
      ];
      const result = streamText({
        model: provider(config.model),
        system: ANSWER_SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
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
