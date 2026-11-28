import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  type AgentCommand,
  type AgentFrame,
  type AgentWorkerExit,
  type AgentWorkerHost as AgentWorkerHostPort,
  AgentWorkerStartError,
  type InterviewWorkerEvent,
} from "@answra/agent";
import {
  agentServiceDisconnectedError,
  type ConversationSnapshot,
  type InterviewPcmFrame,
  isAgentServiceDisconnectedError,
  type TtsSpeakIntent,
} from "@answra/shared";
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";
import { app, type UtilityProcess, utilityProcess } from "electron";
import type { ResolvedModel } from "../conversation/modelRouter";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type RequestCommand = Exclude<AgentCommand, { type: "interview-audio-frame" }>;

/** worker 启动后等待就绪探测的上限；本地资源在面试开始时才加载，启动本身应很快。 */
const WORKER_READY_TIMEOUT_MS = 15_000;
/** 退出时等待 worker 写完最终 transcript 的上限；超时才强制结束进程。 */
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface AgentWorkerProcessOptions {
  resolveModel: (options?: { forceRefresh?: boolean }) => Promise<ResolvedModel>;
  log?: (message: string, error?: unknown) => void;
}

/** 演练/辅助 Bot 提交交接后由 agent 发出的阶段事件；desktop 据此切回资料整理。 */
export interface InterviewStageEvent {
  stage: "profile-review";
  conversationId: string;
  reason: "interview-ended" | "user-requested" | "blocked-by-gap";
  summary: string;
}

/**
 * Electron utility process 的 worker host 适配：唯一负责创建/停止进程、
 * 请求应答、反向令牌请求与帧分发；连接状态机只通过端口调用它。
 */
export class AgentWorkerProcess implements AgentWorkerHostPort {
  private worker?: UtilityProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly sessionFrameListeners = new Set<(frame: SessionFrame) => void>();
  private readonly liveFrameListeners = new Set<(frame: LiveFrame) => void>();
  private readonly snapshotListeners = new Set<(snapshot: ConversationSnapshot) => void>();
  private readonly interviewListeners = new Set<(event: InterviewWorkerEvent) => void>();
  private readonly interviewStageListeners = new Set<(event: InterviewStageEvent) => void>();
  private readonly ttsSpeakListeners = new Set<(intent: TtsSpeakIntent) => void>();
  private readonly interviewAudioCreditListeners = new Set<
    (credit: { sessionId: string; count: number }) => void
  >();
  private readonly exitListeners = new Set<(exit: AgentWorkerExit) => void>();

  constructor(private readonly options: AgentWorkerProcessOptions) {}

  async start(): Promise<void> {
    const workerPath = path.join(app.getAppPath(), "out/main/conversation/worker.cjs");
    // worker 无法访问 Electron app 路径 API，资源目录以启动参数传入（见 worker.ts）。
    const worker = utilityProcess.fork(
      workerPath,
      [
        resolveVadResourceRoot(),
        resolveAsrResourceRoot(),
        resolveSessionsRoot(),
        resolveBuiltinSkillsRoot(),
        resolveUserSkillsRoot(),
        path.join(app.getPath("userData"), "AGENTS.md"),
      ],
      {
        cwd: app.getPath("userData"),
        serviceName: "Answra Agent Runtime",
        stdio: "pipe",
      },
    );
    this.worker = worker;
    if (worker.stdout) {
      createInterface({ input: worker.stdout }).on("line", (line) => console.info(line));
    }
    if (worker.stderr) {
      createInterface({ input: worker.stderr }).on("line", (line) => console.error(line));
    }
    worker.on("message", (message) => {
      // 旧 worker 的迟到帧不能写入新连接或新一轮请求。
      if (this.worker === worker) this.onFrame(message as AgentFrame);
    });
    worker.on("exit", (code) => this.handleExit(worker, code));
    console.info("[agent-service] started", { pid: worker.pid, packaged: app.isPackaged });
    try {
      await this.request("ping", {}, { timeoutMs: WORKER_READY_TIMEOUT_MS });
    } catch (error) {
      if (this.worker === worker) this.worker = undefined;
      worker.kill();
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentWorkerStartError(
        isAgentServiceDisconnectedError(error) ? "worker-exit" : "readiness-timeout",
        detail,
      );
    }
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    await waitForWorkerShutdown(worker);
    this.failPending(agentServiceDisconnectedError("本地 AI 服务已关闭"));
  }

  onExit(listener: (exit: AgentWorkerExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onSessionFrame(listener: (frame: SessionFrame) => void): () => void {
    this.sessionFrameListeners.add(listener);
    return () => this.sessionFrameListeners.delete(listener);
  }

  onLiveFrame(listener: (frame: LiveFrame) => void): () => void {
    this.liveFrameListeners.add(listener);
    return () => this.liveFrameListeners.delete(listener);
  }

  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onInterviewEvent(listener: (event: InterviewWorkerEvent) => void): () => void {
    this.interviewListeners.add(listener);
    return () => this.interviewListeners.delete(listener);
  }

  onInterviewStage(listener: (event: InterviewStageEvent) => void): () => void {
    this.interviewStageListeners.add(listener);
    return () => this.interviewStageListeners.delete(listener);
  }

  /** 演练回复的朗读文本增量；合成归宿主，worker 不持凭证。 */
  onTtsSpeak(listener: (intent: TtsSpeakIntent) => void): () => void {
    this.ttsSpeakListeners.add(listener);
    return () => this.ttsSpeakListeners.delete(listener);
  }

  onInterviewAudioCredit(
    listener: (credit: { sessionId: string; count: number }) => void,
  ): () => void {
    this.interviewAudioCreditListeners.add(listener);
    return () => this.interviewAudioCreditListeners.delete(listener);
  }

  /** 重连后由领域层推送权威快照；不经过 worker 帧，避免伪造事件。 */
  publishSnapshot(snapshot: ConversationSnapshot): void {
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  request(
    type: RequestCommand["type"],
    payload: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(agentServiceDisconnectedError("本地 AI 服务尚未启动"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle: Pending = {
        resolve: (value) => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        },
      };
      this.pending.set(id, settle);
      if (options?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`Agent worker 请求超时: ${type}`));
        }, options.timeoutMs);
      }
      worker.postMessage({ id, type, ...payload } as AgentCommand);
    });
  }

  sendInterviewPcmFrame(frame: InterviewPcmFrame): void {
    const worker = this.worker;
    if (!worker) return;
    worker.postMessage({ type: "interview-audio-frame", frame } satisfies AgentCommand);
  }

  private handleExit(worker: UtilityProcess, code: number | null): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    const detail = `Agent worker 已退出 (${code})`;
    this.failPending(agentServiceDisconnectedError(detail));
    const exit: AgentWorkerExit = { code };
    for (const listener of this.exitListeners) listener(exit);
  }

  private onFrame(frame: AgentFrame): void {
    if (frame.version !== 1) return;
    if (frame.type === "session-frame") {
      for (const listener of this.sessionFrameListeners) listener(frame.frame);
      return;
    }
    if (frame.type === "live-frame") {
      for (const listener of this.liveFrameListeners) listener(frame.frame);
      return;
    }
    if (frame.type === "conversation-snapshot") {
      for (const listener of this.snapshotListeners) listener(frame.snapshot);
      return;
    }
    if (frame.type === "interview-event") {
      for (const listener of this.interviewListeners) listener(frame.event);
      return;
    }
    if (frame.type === "interview-stage") {
      const { stage, conversationId, reason, summary } = frame;
      for (const listener of this.interviewStageListeners)
        listener({ stage, conversationId, reason, summary });
      return;
    }
    if (frame.type === "tts-speak") {
      const { conversationId, messageId, sequence, delta, final } = frame;
      for (const listener of this.ttsSpeakListeners) {
        listener({ conversationId, messageId, sequence, delta, final });
      }
      return;
    }
    if (frame.type === "interview-audio-credit") {
      for (const listener of this.interviewAudioCreditListeners)
        listener({ sessionId: frame.sessionId, count: frame.count });
      return;
    }
    // worker 反向请求平台能力（当前只有令牌刷新）：平台实现留在 main，agent 只发请求。
    if (frame.type === "token-request") {
      void this.answerTokenRequest(frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.value);
    else pending.reject(new Error(frame.error));
  }

  private async answerTokenRequest(frame: { id: string; forceRefresh: boolean }): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      const { accessToken } = await this.options.resolveModel({
        forceRefresh: frame.forceRefresh,
      });
      worker.postMessage({ id: frame.id, type: "token", accessToken } as AgentCommand);
    } catch (error) {
      const message = error instanceof Error ? error.message : "令牌刷新失败";
      this.options.log?.("[agent-service] 令牌请求失败", error);
      worker.postMessage({ id: frame.id, type: "token", error: message } as AgentCommand);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function waitForWorkerShutdown(worker: UtilityProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      worker.kill();
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
    worker.once("exit", finish);
    try {
      worker.postMessage({ id: randomUUID(), type: "shutdown" } satisfies AgentCommand);
    } catch {
      worker.kill();
      finish();
    }
  });
}

/** 预编译 VAD 资源目录：打包版经 extraResources 落在 resourcesPath/vad。 */
function resolveVadResourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "vad")
    : path.join(app.getAppPath(), "resources", "vad");
}

/** 本地 ASR 模型资源目录：打包版经 extraResources 落在 resourcesPath/asr。 */
function resolveAsrResourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "asr")
    : path.join(app.getAppPath(), "resources", "asr");
}

/** 桌面会话历史根目录：与 CLI 的 cli/sessions 明确隔离。 */
function resolveSessionsRoot(): string {
  return path.join(app.getPath("userData"), "desktop-sessions");
}

/** 内置 skill 目录：打包版经 extraResources 落在 resourcesPath/skills。 */
function resolveBuiltinSkillsRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "skills")
    : path.join(app.getAppPath(), "resources", "skills");
}

/** 用户级 skill 目录：跨项目复用，与 CLI 共用同一位置。 */
function resolveUserSkillsRoot(): string {
  return path.join(app.getPath("home"), ".answra", "skills");
}
