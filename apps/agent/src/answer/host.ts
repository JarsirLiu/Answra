import type { AgentEventEnvelope } from "@answra/shared/schema";
import { AgentRuntime } from "../core/agent/runtime";
import { MemoryConversationStore } from "../core/transcript/memoryStore";
import type { ConversationStore } from "../core/transcript/store";
import { MemoryExecutionStore } from "../execution/memoryStore";
import type { ExecutionStore } from "../execution/store";
import type { AgentCommand, AgentFrame } from "../worker/protocol";
import { screenshotAnswerAgent } from "./agent";
import { AnswerApplication } from "./application";

/** Transport boundary used by the answer-only worker composition. */
export interface AnswerAgentTransport {
  send(frame: AgentFrame): void;
  onCommand(listener: (command: AgentCommand) => void): void;
  close?(): void;
}

export interface AnswerAgentHost {
  answer: AnswerApplication;
  dispose(): void;
}

export interface AnswerAgentHostOptions {
  transport: AnswerAgentTransport;
  store?: ConversationStore;
  executionStore?: ExecutionStore;
}

/** Composition root for the answer profile; it has no interview runtime or media dependencies. */
export function startAnswerAgentHost({
  transport,
  store = new MemoryConversationStore(),
  executionStore = new MemoryExecutionStore(),
}: AnswerAgentHostOptions): AnswerAgentHost {
  const tokenRequests = new Map<
    string,
    (result: { accessToken?: string; error?: string }) => void
  >();
  let requestSequence = 0;
  let disposed = false;
  const agentRuntime = new AgentRuntime({
    executionStore,
    emitEvent: (event: AgentEventEnvelope) => transport.send({ version: 1, type: "event", event }),
    tokenProvider: () =>
      new Promise((resolve, reject) => {
        const id = `answer-token-request:${++requestSequence}`;
        tokenRequests.set(id, (result) => {
          if (result.accessToken) resolve(result.accessToken);
          else reject(new Error(result.error ?? "令牌刷新失败"));
        });
        transport.send({ version: 1, type: "token-request", id, forceRefresh: true });
      }),
  });
  const answerAgent = agentRuntime.registerAgent(screenshotAnswerAgent);
  const answer = new AnswerApplication({ agentRuntime, store, executor: answerAgent });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const settle of tokenRequests.values()) settle({ error: "本地 AI 服务已关闭" });
    tokenRequests.clear();
    answer.dispose();
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
    if (command.type === "token") {
      const settle = tokenRequests.get(command.id);
      if (!settle) return;
      tokenRequests.delete(command.id);
      settle({ accessToken: command.accessToken, error: command.error });
      return;
    }
    if (command.type === "interview-audio-frame") return;

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

  async function run(
    command: Exclude<AgentCommand, { type: "shutdown" | "token" | "interview-audio-frame" }>,
  ) {
    switch (command.type) {
      case "configure":
        answer.configure(command.config);
        return undefined;
      case "workspace-context":
        return undefined;
      case "chat-send":
        throw new Error("对话功能不包含在此安装包中");
      case "answer-run":
        return answer.run(command.conversationId, command.request, command.accessToken);
      case "snapshot":
        return answer.getSnapshot(command.conversationId);
      case "read-events":
        return answer.readEventsAfter(command.conversationId, command.afterRevision);
      case "create-conversation":
        return answer.createConversation(command.conversationId);
      case "clear-conversation": {
        const snapshot = await answer.clearConversation(command.conversationId);
        transport.send({ version: 1, type: "conversation-snapshot", snapshot });
        return snapshot;
      }
      case "append-user-message":
        return answer.appendUserMessage(command.conversationId, command.text);
      case "cancel":
        answer.cancel(command.runId);
        return undefined;
      case "interview-start":
      case "interview-capture-ready":
      case "interview-capture-failed":
      case "interview-stop":
        throw new Error("面试功能不包含在此安装包中");
    }
  }

  return { answer, dispose };
}
