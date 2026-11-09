import type { ConversationSnapshot } from "@answra/shared";
import { INTERVIEW_AUDIO_CREDIT_BATCH } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { screenshotAnswerAgent } from "./answer/agent";
import { AnswerApplication } from "./answer/application";
import { createConversationAgentDefinition } from "./conversation/agent";
import { ConversationApplication } from "./conversation/application";
import { AgentRuntime } from "./core/agent/runtime";
import { createBuiltinToolRegistry } from "./core/tool";
import { MemoryConversationStore } from "./core/transcript/memoryStore";
import type { ConversationStore } from "./core/transcript/store";
import { MemoryExecutionStore } from "./execution/memoryStore";
import type { ExecutionStore } from "./execution/store";
import { createInterviewReplyAgent } from "./interview/agent";
import { InterviewApplication } from "./interview/application";
import type { InterviewDomainEvent } from "./interview/contracts";
import { InterviewRuntime } from "./interview/runtime";
import type { RecognizerSource } from "./interview/transcription/local/recognizerPort";
import type { TenVadSource } from "./interview/vad/tenVadEngine";
import { toInterviewWorkerEvent } from "./interview/workerProjection";
import type { AgentCommand, AgentFrame } from "./worker/protocol";

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
  executionStore?: ExecutionStore;
  /**
   * 面试 VAD 的资源来源（预编译 TEN VAD wasm 由 desktop 组合根读盘后注入）。
   * 未注入时 interview-start 会显式失败：不静默降级为无 VAD 会话。
   */
  vad: TenVadSource;
  /**
   * 本地转录引擎的装配来源（manifest 校验 + addon 构造由 desktop 组合根注入）。
   * 未注入时 interview-start 会显式失败：不静默降级为无转录会话。
   */
  recognizer: RecognizerSource;
  /**
   * candidate turn settle 合并参数（测试注入 settleMs:0 以获得同步结算）。
   * 缺省用默认窗口：真实面试延迟特征待校准后再收敛默认值。
   */
  turnSettler?: import("./interview/turns/settler").CandidateTurnSettlerOptions;
}

export interface AgentHost {
  runtime: ConversationApplication;
  answer: AnswerApplication;
  /** Publishes a domain event for desktop-main projection into renderer DTOs. */
  emitInterviewEvent(event: InterviewDomainEvent): void;
  dispose(): void;
}

/** 云端令牌刷新请求的等待上限。 */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Agent 组合根：把 worker transport、领域处理和运行时装配在一起。
 * 这是唯一允许知道"命令怎么分发"的地方——领域模块只暴露方法。
 * 桌面 adapter 通过 transport 下发上下文和用户输入；Agent 工具不经 transport 调用 desktop。
 */
export function startAgentHost({
  transport,
  store = new MemoryConversationStore(),
  executionStore = new MemoryExecutionStore(),
  vad,
  recognizer,
  turnSettler,
}: AgentHostOptions): AgentHost {
  /** 云端令牌的等待表：run 启动与 401 刷新共用同一条反向请求。 */
  const tokenRequests = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  let requestSeq = 0;

  function requestAccessToken(options: { forceRefresh: boolean }): Promise<string> {
    const id = `token-request:${++requestSeq}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = tokenRequests.get(id);
        if (!pending) return;
        tokenRequests.delete(id);
        pending.cleanup();
        pending.reject(new Error("令牌刷新超时"));
      }, TOKEN_REQUEST_TIMEOUT_MS);
      tokenRequests.set(id, {
        resolve,
        reject,
        cleanup: () => clearTimeout(timer),
      });
      transport.send({
        version: 1,
        type: "token-request",
        id,
        forceRefresh: options.forceRefresh,
      });
    });
  }

  const agentRuntime = new AgentRuntime({
    executionStore,
    emitEvent: (event: AgentEventEnvelope) => transport.send({ version: 1, type: "event", event }),
    tokenProvider: requestAccessToken,
  });
  const conversationAgent = agentRuntime.registerAgent(
    createConversationAgentDefinition({ store, tools: createBuiltinToolRegistry() }),
  );
  const answerAgent = agentRuntime.registerAgent(screenshotAnswerAgent);
  const interviewAgent = agentRuntime.registerAgent(createInterviewReplyAgent(store));
  const runtime = new ConversationApplication({
    agentRuntime,
    store,
    conversationAgent,
  });
  const answer = new AnswerApplication({ agentRuntime, store, executor: answerAgent });

  const interview = new InterviewApplication({
    agentRuntime,
    store,
    executor: interviewAgent,
    requestAccessToken: () => requestAccessToken({ forceRefresh: false }),
    onSnapshot: async (snapshot) => emitConversationSnapshot(snapshot),
    onTurnCommitted: (turn) => emitInterviewEvent({ type: "turn-committed", turn }),
    onError: (stage, error) => {
      console.warn("[interview-reply] failed", {
        stage,
        error: error instanceof Error ? error.message : "unknown",
      });
    },
  });

  const interviewRuntime = new InterviewRuntime({
    application: interview,
    vad,
    recognizer,
    turnSettler,
    emit: (event) => emitInterviewEvent(event),
  });
  let audioCreditSessionId: string | undefined;
  let uncreditedAudioFrames = 0;

  function emitInterviewEvent(event: InterviewDomainEvent): void {
    if (disposed) return;
    transport.send({ version: 1, type: "interview-event", event: toInterviewWorkerEvent(event) });
  }

  function emitConversationSnapshot(snapshot: ConversationSnapshot): void {
    if (disposed) return;
    transport.send({ version: 1, type: "conversation-snapshot", snapshot });
  }

  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // 运行时马上关闭：挂起内容不做异步结算，显式丢弃而非冒险 race。
    interviewRuntime.dispose();
    void interview.stop();
    for (const pending of tokenRequests.values()) {
      pending.cleanup();
      pending.reject(new Error("本地 AI 服务已关闭"));
    }
    tokenRequests.clear();
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
    // 宿主对令牌刷新的回答：不经过 run()，也不回响应帧。
    if (command.type === "token") {
      const pending = tokenRequests.get(command.id);
      if (!pending) return;
      tokenRequests.delete(command.id);
      pending.cleanup();
      // 本地端点可以合法地返回空 token（不需要 Authorization）；只有显式 error
      // 才是失败，不能把空字符串当成“没有回答”。
      if (command.error !== undefined) pending.reject(new Error(command.error));
      else pending.resolve(command.accessToken ?? "");
      return;
    }
    if (command.type === "interview-audio-frame") {
      const result = interviewRuntime.acceptFrame(command.frame);
      if (!result.accepted) {
        console.warn("[interview-audio] frame rejected", result.code);
      } else if (command.frame.sessionId === audioCreditSessionId) {
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
      case "interview-start": {
        await interviewRuntime.start(command.sessionId, command.conversationId);
        audioCreditSessionId = command.sessionId;
        uncreditedAudioFrames = 0;
        return undefined;
      }
      case "interview-capture-ready":
        if (!interviewRuntime.captureReady(command.sessionId))
          throw new Error("面试音频会话已失效");
        return undefined;
      case "interview-capture-failed":
        interviewRuntime.captureFailed(command.sessionId);
        clearAudioCredits(command.sessionId);
        return undefined;
      case "interview-stop":
        // 停止即结算：用户刚说完就按停，不再等 settle 窗口，内容不丢。
        interviewRuntime.stop(command.sessionId);
        clearAudioCredits(command.sessionId);
        return undefined;
      case "configure":
        runtime.configure(command.config);
        return undefined;
      case "workspace-context":
        runtime.setWorkspaceRoot(command.root);
        return undefined;
      case "chat-send":
        return runtime.sendChat(
          command.profileId,
          command.conversationId,
          command.request,
          command.accessToken,
        );
      case "answer-run":
        return answer.run(command.conversationId, command.request, command.accessToken);
      case "snapshot":
        return runtime.getSnapshot(command.conversationId);
      case "read-events":
        return runtime.readEventsAfter(command.conversationId, command.afterRevision);
      case "create-conversation":
        return runtime.createConversation(command.conversationId);
      case "clear-conversation": {
        const snapshot = await runtime.clearConversation(command.conversationId);
        emitConversationSnapshot(snapshot);
        return snapshot;
      }
      case "append-user-message":
        return runtime.appendUserMessage(command.conversationId, command.text);
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

  return {
    runtime,
    answer,
    emitInterviewEvent,
    dispose,
  };
}
