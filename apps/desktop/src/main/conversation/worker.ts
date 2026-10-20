import { startAgentWorker } from "./workerTransport";

/** Electron utility process entry point for the Agent runtime. */
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Agent worker must run as an Electron utility process");
// AgentService 启动时传入的 VAD 资源目录（worker 里没有 Electron app 路径 API）。
const vadResourceRoot = process.argv[2];
if (typeof vadResourceRoot !== "string" || vadResourceRoot.length === 0)
  throw new Error("Agent worker 缺少 VAD 资源目录启动参数");
startAgentWorker(parentPort, { vadResourceRoot });
