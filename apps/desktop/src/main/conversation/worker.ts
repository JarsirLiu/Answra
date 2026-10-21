import { startAgentWorker } from "./workerTransport";

/** Electron utility process entry point for the Agent runtime. */
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Agent worker must run as an Electron utility process");
// AgentService 启动时传入的预编译资源目录（worker 里没有 Electron app 路径 API）：
// argv[2] = VAD（TEN VAD wasm），argv[3] = 本地 ASR（paraformer 模型 + tokens）。
const vadResourceRoot = process.argv[2];
if (typeof vadResourceRoot !== "string" || vadResourceRoot.length === 0)
  throw new Error("Agent worker 缺少 VAD 资源目录启动参数");
const asrResourceRoot = process.argv[3];
if (typeof asrResourceRoot !== "string" || asrResourceRoot.length === 0)
  throw new Error("Agent worker 缺少 ASR 资源目录启动参数");
startAgentWorker(parentPort, { vadResourceRoot, asrResourceRoot });
