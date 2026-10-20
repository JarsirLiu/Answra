import type {
  AgentCommand,
  AgentFrame,
  AgentHost,
  AgentTransport,
  TenVadSource,
} from "@answra/agent";
import { startAgentHost } from "@answra/agent";
import { createTenVadFileSource } from "../interview/tenVadResources";

/** Adapts Electron's utility-process message port to the platform-neutral Agent host. */
export interface AgentWorkerOptions {
  /** 由 AgentService 解析的预编译 VAD 资源目录（resources/vad）。 */
  vadResourceRoot?: string;
  /** 测试注入：绕过从磁盘加载预编译资源。 */
  vad?: TenVadSource;
}

export function startAgentWorker(
  parentPort: Electron.ParentPort,
  options?: AgentWorkerOptions,
): AgentHost {
  const transport: AgentTransport = {
    send: (frame: AgentFrame) => parentPort.postMessage(frame),
    onCommand: (listener) =>
      parentPort.on("message", ({ data }: Electron.MessageEvent) => {
        listener(data as AgentCommand);
      }),
    close: () => process.exit(0),
  };

  const vad =
    options?.vad ??
    // 缺省路径时文件源会在加载阶段以显式错误失败（fail-closed），而不是假装可用。
    createTenVadFileSource(options?.vadResourceRoot ?? "");
  return startAgentHost({ transport, vad });
}
