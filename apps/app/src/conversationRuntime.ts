import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  ConversationEvent,
  ConversationModelConfig,
  ConversationSendRequest,
} from "@answra/shared";
import { streamText } from "ai";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export class ConversationRuntime {
  private config?: ConversationModelConfig;
  private readonly runs = new Map<string, AbortController>();

  constructor(private readonly emit: (event: ConversationEvent) => void) {}

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

  async send(request: ConversationSendRequest): Promise<{ runId: string }> {
    if (!this.config) throw new Error("请先在设置中配置模型服务");
    validateRequest(request);

    const runId = randomUUID();
    const controller = new AbortController();
    const config = this.config;
    this.runs.set(runId, controller);
    this.emit({ type: "run/started", runId, conversationId: runId });
    void this.execute(runId, config, request, controller);
    return { runId };
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.abort();
  }

  dispose(): void {
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
  }

  get activeRunCount(): number {
    return this.runs.size;
  }

  private async execute(
    runId: string,
    config: ConversationModelConfig,
    request: ConversationSendRequest,
    controller: AbortController,
  ): Promise<void> {
    try {
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
        messages: [{ role: "user", content }],
        abortSignal: controller.signal,
      });
      for await (const delta of result.textStream) this.emit({ type: "text/delta", runId, delta });
      if (controller.signal.aborted) throw new Error("请求已取消");
      this.emit({ type: "run/completed", runId });
    } catch (error) {
      if (controller.signal.aborted) this.emit({ type: "run/cancelled", runId });
      else
        this.emit({
          type: "run/failed",
          runId,
          message: error instanceof Error ? error.message : "模型请求失败",
        });
    } finally {
      this.runs.delete(runId);
    }
  }
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
