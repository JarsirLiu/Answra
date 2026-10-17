import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentCommand, AgentFrame } from "@answra/agent";
import type {
  ConversationChange,
  ConversationModelConfig,
  ConversationSendRequest,
} from "@answra/shared";
import { app, safeStorage, type UtilityProcess, utilityProcess } from "electron";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const CONFIG_FILE = "conversation-model.json";

export class AgentService {
  private worker?: UtilityProcess;
  private readonly pending = new Map<string, Pending>();
  private config?: ConversationModelConfig;
  private readonly listeners = new Set<(change: ConversationChange) => void>();

  async start(): Promise<void> {
    this.config = await this.readConfig();
    const workerPath = path.join(app.getAppPath(), "out/main/conversation/worker.cjs");
    const worker = utilityProcess.fork(workerPath, [], {
      cwd: app.getPath("userData"),
      serviceName: "Answra Agent Runtime",
      stdio: "ignore",
    });
    this.worker = worker;
    worker.on("message", (message) => this.onFrame(message as AgentFrame));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.failPending(new Error(`本地 AI 服务已退出 (${code})`));
    });
    if (this.config) await this.configure(this.config);
    console.info("[agent-service] started", { pid: worker.pid, packaged: app.isPackaged });
  }

  onChange(listener: (change: ConversationChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getConfig(): Promise<Omit<ConversationModelConfig, "apiKey"> & { configured: boolean }> {
    const config = this.config;
    return {
      baseUrl: config?.baseUrl ?? "",
      model: config?.model ?? "",
      configured: Boolean(config?.baseUrl && config?.model),
    };
  }

  /** 按需返回已解密 API Key（设置面板显隐回显）；未保存时为 null。 */
  async getApiKey(): Promise<{ apiKey: string | null }> {
    return { apiKey: this.config?.apiKey ?? null };
  }

  async configure(config: ConversationModelConfig): Promise<void> {
    validateConfig(config);
    const previous = this.config;
    const next = { ...config, apiKey: config.apiKey || previous?.apiKey };
    await this.writeConfig(next);
    try {
      await this.request("configure", { config: next });
      this.config = next;
    } catch (error) {
      this.config = previous;
      await this.writeConfig(previous).catch(() => undefined);
      throw error;
    }
  }

  async getSnapshot(conversationId: string) {
    return this.request("snapshot", { conversationId });
  }

  async createConversation(conversationId: string) {
    return this.request("create-conversation", { conversationId });
  }

  async readEvents(conversationId: string, afterRevision: number) {
    return this.request("read-events", { conversationId, afterRevision });
  }

  async send(conversationId: string, request: ConversationSendRequest): Promise<{ runId: string }> {
    if (!this.config) throw new Error("请先在设置中配置模型服务");
    validateSendRequest(request);
    return (await this.request("send", { conversationId, request })) as { runId: string };
  }

  cancel(runId: string): void {
    void this.request("cancel", { runId }).catch((error: unknown) =>
      console.warn("[agent-service] cancel failed", error),
    );
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    worker.kill();
    this.failPending(new Error("本地 AI 服务已关闭"));
  }

  private request(type: AgentCommand["type"], payload: Record<string, unknown>): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("本地 AI 服务尚未启动"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload } as AgentCommand);
    });
  }

  private onFrame(frame: AgentFrame): void {
    if (frame.version !== 1) return;
    if (frame.type === "change") {
      for (const listener of this.listeners) listener(frame.change);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.value);
    else pending.reject(new Error(frame.error));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async readConfig(): Promise<ConversationModelConfig | undefined> {
    try {
      const stored = JSON.parse(
        await readFile(path.join(app.getPath("userData"), CONFIG_FILE), "utf8"),
      ) as { baseUrl: string; model: string; encryptedKey?: string };
      const apiKey =
        stored.encryptedKey && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(stored.encryptedKey, "base64"))
          : undefined;
      return { baseUrl: stored.baseUrl, model: stored.model, ...(apiKey ? { apiKey } : {}) };
    } catch {
      return undefined;
    }
  }

  private async writeConfig(config: ConversationModelConfig | undefined): Promise<void> {
    const file = path.join(app.getPath("userData"), CONFIG_FILE);
    if (!config) {
      await rm(file, { force: true });
      return;
    }
    if (config.apiKey && !safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用，未保存 API Key");
    const userData = app.getPath("userData");
    await mkdir(userData, { recursive: true });
    const stored = {
      baseUrl: config.baseUrl,
      model: config.model,
      encryptedKey: config.apiKey
        ? safeStorage.encryptString(config.apiKey).toString("base64")
        : undefined,
    };
    await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  }
}

function validateConfig(config: ConversationModelConfig): void {
  const url = new URL(config.baseUrl);
  if (
    !(url.protocol === "http:" || url.protocol === "https:") ||
    url.username ||
    url.password ||
    !config.model.trim()
  )
    throw new Error("模型服务配置无效");
}

function validateSendRequest(request: ConversationSendRequest): void {
  if (typeof request.text !== "string" || request.text.length > 32_000)
    throw new Error("消息内容无效或过长");
  if (!Array.isArray(request.images) || request.images.length > 8)
    throw new Error("单次最多发送 8 张图片");
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  for (const image of request.images) {
    if (
      typeof image.name !== "string" ||
      image.name.length > 256 ||
      typeof image.dataUrl !== "string" ||
      image.dataUrl.length > 11_200_000
    )
      throw new Error("图片附件无效或过大");
    const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match?.[1] || !allowedTypes.has(match[1]) || !match[2])
      throw new Error("图片格式仅支持 PNG、JPEG、WebP 或 GIF");
  }
}
