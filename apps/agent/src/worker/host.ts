import { ConversationRuntime } from "../conversation/runtime";
import { type ConversationStore, MemoryConversationStore } from "../conversation/store";
import type { AgentCommand, AgentFrame } from "./protocol";

/**
 * agent 与宿主进程之间的传输。agent 只认这个接口：宿主是 Electron utility
 * process、独立 sidecar 还是测试里的假传输，对运行时都一样。
 */
export interface AgentTransport {
  /** 上行帧：响应与 change。 */
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
  dispose(): void;
}

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
  const runtime = new ConversationRuntime(
    (change) => transport.send({ version: 1, type: "change", change }),
    store,
  );

  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
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
      case "configure":
        runtime.configure(command.config);
        return undefined;
      case "send":
        return runtime.send(command.conversationId, command.request);
      case "snapshot":
        return runtime.getSnapshot(command.conversationId);
      case "read-events":
        return runtime.readEventsAfter(command.conversationId, command.afterRevision);
      case "create-conversation":
        return runtime.createConversation(command.conversationId);
      case "cancel":
        runtime.cancel(command.runId);
        return undefined;
      // 实际在上面就被拦下：shutdown 不发送响应帧，直接 dispose + close。
      case "shutdown":
        return undefined;
    }
  }

  return { runtime, dispose };
}
