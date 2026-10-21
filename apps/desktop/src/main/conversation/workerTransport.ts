import type {
  AgentCommand,
  AgentFrame,
  AgentHost,
  AgentTransport,
  RecognizerSource,
  TenVadSource,
} from "@answra/agent";
import { startAgentHost } from "@answra/agent";
import { createParaformerRecognizerModule } from "../interview/asrRecognizer";
import { createTenVadFileSource } from "../interview/tenVadResources";

/** Adapts Electron's utility-process message port to the platform-neutral Agent host. */
export interface AgentWorkerOptions {
  /** 由 AgentService 解析的预编译 VAD 资源目录（resources/vad）。 */
  vadResourceRoot?: string;
  /** 由 AgentService 解析的本地 ASR 模型资源目录（resources/asr）。 */
  asrResourceRoot?: string;
  /** 测试注入：绕过从磁盘加载预编译资源。 */
  vad?: TenVadSource;
  /** 测试注入：绕过从磁盘加载本地模型。 */
  recognizer?: RecognizerSource;
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
  const recognizer = createRecognizer(options?.recognizer, options?.asrResourceRoot ?? "");
  return startAgentHost({ transport, vad, recognizer });
}

function createRecognizer(
  injected: RecognizerSource | undefined,
  asrResourceRoot: string,
): RecognizerSource {
  if (injected) return injected;
  return {
    // 缺省路径时装配在加载阶段以显式错误失败（fail-closed），而不是假装可用。
    load: async () => {
      const setup = await createParaformerRecognizerModule(asrResourceRoot);
      return { module: setup.module, recipe: setup.recipe };
    },
  };
}
