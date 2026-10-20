import { INTERVIEW_AUDIO_CREDIT_BATCH } from "@answra/shared";
import { ConversationRuntime } from "../conversation/runtime";
import { type ConversationStore, MemoryConversationStore } from "../conversation/store";
import { InterviewAudioIngress } from "../interview/audio/ingress";
import {
  conversationId as asConversationId,
  sessionId as asSessionId,
  type InterviewDomainEvent,
} from "../interview/contracts";
import { toInterviewWorkerEvent } from "./interviewProjection";
import type { AgentCommand, AgentFrame } from "./protocol";

/**
 * agent 与宿主进程之间的传输。agent 只认这个接口：宿主是 Electron utility
 * process、独立 sidecar 还是测试里的假传输，对运行时都一样。
 */
export interface AgentTransport {
  /** 上行帧：响应、change 与平台能力请求。 */
  send(frame: AgentFrame): void;
  /** 下行命令；同一 transport 只应注册一次。 */
  onCommand(listener: (command: AgentCommand) => void): void;
  /** 宿主收尾（Electron adapter 在此退出进程）；agent 只负责调用。 */
  close?(): void;
}

export interface AgentHostOptions {
  transport: AgentTransport;
  store?: ConversationStore;
}

export interface AgentHost {
  runtime: ConversationRuntime;
  /** Publishes a domain event for desktop-main projection into renderer DTOs. */
  emitInterviewEvent(event: InterviewDomainEvent): void;
  dispose(): void;
}

/** 反向请求的等待上限：宿主不实现该能力时不能把一次运行挂死。 */
const CAPABILITY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 组装点：把传输、会话运行时与（将来接入的）工具/能力适配器装配在一起。
 * 这是唯一允许知道"命令怎么分发"的地方——领域模块只暴露方法，
 * 平台能力实现留在 desktop，通过 transport 上的帧交互（agent 是独立进程，
 * 不能靠注入对象拿到宿主的平台 API）。
 */
export function startAgentHost({
  transport,
  store = new MemoryConversationStore(),
}: AgentHostOptions): AgentHost {
  /** 反向请求（agent → 宿主）的等待表：宿主用同 id 的命令帧回答。 */
  const capabilityRequests = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >();
  let requestSeq = 0;

  function requestToken(): Promise<string> {
    const id = `token-request:${++requestSeq}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (capabilityRequests.delete(id)) reject(new Error("令牌刷新超时"));
      }, CAPABILITY_REQUEST_TIMEOUT_MS);
      capabilityRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      transport.send({ version: 1, type: "token-request", id, forceRefresh: true });
    });
  }

  const runtime = new ConversationRuntime({
    emit: (change) => transport.send({ version: 1, type: "change", change }),
    store,
    tokenProvider: requestToken,
  });

  const interviewAudio = new InterviewAudioIngress({
    emit: (event) => emitInterviewEvent(event),
    onFrame: () => undefined,
  });
  let audioCreditSessionId: string | undefined;
  let uncreditedAudioFrames = 0;

  function emitInterviewEvent(event: InterviewDomainEvent): void {
    if (disposed) return;
    transport.send({ version: 1, type: "interview-event", event: toInterviewWorkerEvent(event) });
  }

  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const pending of capabilityRequests.values())
      pending.reject(new Error("本地 AI 服务已关闭"));
    capabilityRequests.clear();
    runtime.dispose();
  }

  transport.onCommand((command) => {
    void handle(command);
  });

  async function handle(command: AgentCommand): Promise<void> {
    if (command.type === "shutdown") {
      dispose();
      transport.close?.();
      return;
    }
    // 宿主对反向请求的回答：不经过 run()，也不回响应帧。
    if (command.type === "token") {
      const pending = capabilityRequests.get(command.id);
      if (!pending) return;
      capabilityRequests.delete(command.id);
      if (command.accessToken) pending.resolve(command.accessToken);
      else pending.reject(new Error(command.error ?? "令牌刷新失败"));
      return;
    }
    if (command.type === "interview-audio-frame") {
      const result = interviewAudio.acceptFrame(command.frame);
      if (!result.accepted) console.warn("[interview-audio] frame rejected", result.code);
      if (command.frame.sessionId === audioCreditSessionId) {
        uncreditedAudioFrames += 1;
        if (uncreditedAudioFrames >= INTERVIEW_AUDIO_CREDIT_BATCH) {
          transport.send({
            version: 1,
            type: "interview-audio-credit",
            sessionId: audioCreditSessionId,
            count: uncreditedAudioFrames,
          });
          uncreditedAudioFrames = 0;
        }
      }
      return;
    }
    try {
      transport.send({
        version: 1,
        type: "response",
        id: command.id,
        ok: true,
        value: await run(command),
      });
    } catch (error) {
      transport.send({
        version: 1,
        type: "response",
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function run(command: AgentCommand): Promise<unknown> {
    switch (command.type) {
      case "interview-start":
        interviewAudio.start(
          asSessionId(command.sessionId),
          asConversationId(command.conversationId),
        );
        audioCreditSessionId = command.sessionId;
        uncreditedAudioFrames = 0;
        return undefined;
      case "interview-capture-ready":
        if (!interviewAudio.captureReady(asSessionId(command.sessionId)))
          throw new Error("面试音频会话已失效");
        return undefined;
      case "interview-capture-failed":
        interviewAudio.fail(asSessionId(command.sessionId), "capture-failed");
        clearAudioCredits(command.sessionId);
        return undefined;
      case "interview-stop":
        interviewAudio.stop(asSessionId(command.sessionId));
        clearAudioCredits(command.sessionId);
        return undefined;
      case "configure":
        runtime.configure(command.config);
        return undefined;
      case "chat-send":
        return runtime.sendChat(
          command.profileId,
          command.conversationId,
          command.request,
          command.accessToken,
        );
      case "answer-run":
        return runtime.runAnswer(command.conversationId, command.request, command.accessToken);
      case "snapshot":
        return runtime.getSnapshot(command.conversationId);
      case "read-events":
        return runtime.readEventsAfter(command.conversationId, command.afterRevision);
      case "create-conversation":
        return runtime.createConversation(command.conversationId);
      case "cancel":
        runtime.cancel(command.runId);
        return undefined;
      // shutdown/token 在上面就被拦下：不发响应帧。
      case "shutdown":
      case "token":
      case "interview-audio-frame":
        return undefined;
    }
  }

  function clearAudioCredits(sessionId: string): void {
    if (audioCreditSessionId !== sessionId) return;
    audioCreditSessionId = undefined;
    uncreditedAudioFrames = 0;
  }

  return { runtime, emitInterviewEvent, dispose };
}
