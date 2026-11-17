import { startAgentWorker } from "./workerTransport";

/** Electron utility process entry point for the Agent runtime. */
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Agent worker must run as an Electron utility process");
// AgentService 启动时传入的预编译资源目录（worker 里没有 Electron app 路径 API）：
// argv[2] = VAD（TEN VAD wasm），argv[3] = 本地 ASR（paraformer 模型 + tokens），
// argv[4] = 会话目录，argv[5] = 内置 skill，argv[6] = 用户级 skill。
const vadResourceRoot = process.argv[2];
if (typeof vadResourceRoot !== "string" || vadResourceRoot.length === 0)
  throw new Error("Agent worker 缺少 VAD 资源目录启动参数");
const asrResourceRoot = process.argv[3];
if (typeof asrResourceRoot !== "string" || asrResourceRoot.length === 0)
  throw new Error("Agent worker 缺少 ASR 资源目录启动参数");
const sessionsRoot = process.argv[4];
if (typeof sessionsRoot !== "string" || sessionsRoot.length === 0)
  throw new Error("Agent worker 缺少会话目录启动参数");
// skill 目录允许不存在：宿主会先解析，是否存在由 agent 按来源逐项判断。
const builtinSkillsRoot = process.argv[5];
const userSkillsRoot = process.argv[6];
startAgentWorker(parentPort, {
  vadResourceRoot,
  asrResourceRoot,
  sessionsRoot,
  ...(typeof builtinSkillsRoot === "string" && builtinSkillsRoot.length > 0
    ? { builtinSkillsRoot }
    : {}),
  ...(typeof userSkillsRoot === "string" && userSkillsRoot.length > 0 ? { userSkillsRoot } : {}),
});
