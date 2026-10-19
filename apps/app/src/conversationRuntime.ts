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
  "你是 Answra 答题助手。用户发来一张或多张题目截图，你只输出答案本身，不输出分析过程。",
  "",
  "第一步，判断截图里有几道「完整可作答」的题：",
  "- 只统计题干完整、能看清并作答的题。",
  "- 图片边缘被截断一半的题、严重模糊或残缺的题，一律忽略，不要提及、不要编号。",
  "- 一道完整题周围多余的水印、页眉页脚、其他无关文字不算题。",
  "",
  "第二步，按以下规范输出；答案永远在最前面，整条回复的第一个字符必须是「答案：」：",
  "- 只有一道完整题：第一行只写「答案：<答案>」，如「答案：B」；这一行之前不得出现题号、题号提示、引子、说明文字或空行。",
  "- 有多道完整题：每题占一行，每行都以「答案：」开头，格式为「答案：<答案>（<题号>）」，如「答案：B（第12题）」「答案：正确（第13题）」；" +
    "「题号」用试卷上印的题号，不要按图片中的顺序自己重新编号；试卷没印题号时，用题干前 10 个字代替题号（如「答案：B（下列说法正确的是）」）。",
  "- 选择题只写选项字母与选项内容；判断题写「正确」或「错误」；填空题只写空内内容；计算、编程题给最终结果，可另起一行列出最多 3 条关键步骤。",
  "- 每题答案之后最多补一句必要理由；没有把握时明确写「不确定」。",
  "- 完整可作答的题一道都没有时，才回复「未识别到题目」。",
  "",
  "禁止事项：不要复述题目、寒暄、总结收尾；不要输出「未识别到题目」「图片不完整」等针对个别题的说明；" +
    "不要使用 Markdown 标题、加粗、列表符号；不要多段展开。",
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
