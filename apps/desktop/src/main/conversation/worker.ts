import type { AgentCommand, AgentFrame, AgentTransport } from "@answra/agent";
import { startAgentHost } from "@answra/agent";

/**
 * Electron utility process 适配器：把 parentPort 消息端口包装成 AgentTransport。
 * 分发循环与组装都在 @answra/agent 的 startAgentHost 里，这里只绑定进程 API。
 */
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Agent worker must run as an Electron utility process");

const transport: AgentTransport = {
  send: (frame: AgentFrame) => parentPort.postMessage(frame),
  onCommand: (listener) =>
    parentPort.on("message", ({ data }: Electron.MessageEvent) => {
      listener(data as AgentCommand);
    }),
  close: () => process.exit(0),
};

startAgentHost({ transport });
