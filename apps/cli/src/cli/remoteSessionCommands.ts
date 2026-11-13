/** CLI 远程会话命令：host 常驻与 controller attach 的组合接线。 */
import type { ModelCredentialStore } from "@answra/credentials";
import {
  isRemoteHostAccessKeyActive,
  RemoteControllerSession,
  type RemoteHostAccessKeyRecord,
} from "@answra/remote";
import { CLI_API_KEY } from "@answra/shared";
import type { CliOptions } from "../config/cliOptions";
import { resolveWorkspaceRoot } from "../config/workspace";
import { resolveModelAccessToken } from "../model/accessToken";
import { createRemoteModelSettings } from "../remote/controller/modelSettings";
import { createRemoteControllerSessionHost } from "../remote/controller/sessionHost";
import { createRemoteCodingHost } from "../remote/host/commandPort";
import { type RemoteHostHandle, startRemoteHost } from "../remote/host/startRemoteHost";
import type { RemoteRuntimeDependencies } from "../remote/runtimeDependencies";
import { connectRemoteSignaling } from "../remote/signaling/connectRemoteSignaling";
import { CodingSession } from "../session/codingSession";
import { TuiViewStore } from "../tui/app/viewStore";
import type { CliDependencies, RemoteKeyDependencies } from "./dependencies";
import { CliUsageError } from "./errors";

type RemoteOptions = Extract<CliOptions, { kind: "remote" }>;

const REMOTE_MODEL_CREDENTIALS: ModelCredentialStore = {
  read: async () => null,
  write: async () => {
    throw new Error("远程会话不保存本机模型 Key；请在 host 本机配置。");
  },
  clear: async () => {
    throw new Error("远程会话不保存本机模型 Key；请在 host 本机配置。");
  },
};

const EMPTY_MODEL_CATALOG = {
  list: async () => [],
};

export async function runRemoteHostCommand(
  options: Extract<RemoteOptions, { action: "host" }>,
  remote: RemoteKeyDependencies,
  deps: CliDependencies,
  now: Date,
): Promise<void> {
  const runtime = requireRemoteRuntime(deps);
  const workspaceRoot = await resolveWorkspaceRoot(options.cwd ?? deps.cwd);
  const record = await selectHostKey(remote, options.keyId, now);
  const accessToken = await resolveModelAccessToken(deps.env[CLI_API_KEY], deps.modelCredentials);
  const createHost = deps.createRemoteHost ?? createRemoteCodingHost;
  const remoteHost = createHost({
    workspaceRoot,
    modelSettings: deps.modelSettings,
    accessToken,
  });

  let handle: RemoteHostHandle;
  try {
    handle = await startRemoteHost({
      runtime,
      hostKeys: remote.hostKeys,
      host: remoteHost.port,
      workspaceRoot,
      roomId: record.roomId,
      onStatus: (line) => deps.output.write(`${line}\n`),
    });
  } catch (error) {
    remoteHost.dispose();
    throw error;
  }

  deps.output.write(
    [
      "Remote host 已启动。",
      `Room ID: ${record.roomId}`,
      `Key ID: ${record.keyId}`,
      `Workspace: ${workspaceRoot}`,
      "等待 controller；Ctrl-C 停止。",
      "",
    ].join("\n"),
  );

  const removeInterrupt = deps.onInterrupt(() => {
    void handle.stop();
  });
  let failure: unknown;
  try {
    await handle.done;
  } catch (error) {
    failure = error;
  } finally {
    removeInterrupt();
    await handle.stop();
    remoteHost.dispose();
  }
  if (failure !== undefined) throw failure;
}

export async function runRemoteAttachCommand(
  options: Extract<RemoteOptions, { action: "attach" }>,
  remote: RemoteKeyDependencies,
  deps: CliDependencies,
  now: Date,
): Promise<number> {
  requireInteractive(deps, "remote attach");
  const runtime = requireRemoteRuntime(deps);
  const credential = await remote.credentials.read();
  if (credential === null) {
    throw new CliUsageError("未保存 controller 密钥。先运行 `answra remote key set`。");
  }
  if (credential.expiresAt !== undefined) {
    const expiresAt = Date.parse(credential.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      throw new CliUsageError("保存的 controller 密钥已过期。先在 host 上重新生成并运行 key set。");
    }
  }

  const peerId = runtime.createId();
  const signaling = await connectRemoteSignaling({
    service: runtime.signaling,
    timers: runtime.timers,
    role: "controller",
    roomId: credential.roomId,
    peerId,
  });
  const link = runtime.createLink({ role: "controller", signaling });
  const session = new RemoteControllerSession({
    link,
    sessionId: runtime.createId(),
    peerId,
    credential,
  });

  let welcome: Awaited<ReturnType<RemoteControllerSession["connect"]>>;
  const removeInterrupt = deps.onInterrupt(() => session.close());
  try {
    welcome = await session.connect();
  } catch (error) {
    session.close();
    signaling.close();
    throw error;
  } finally {
    removeInterrupt();
  }

  const modelSettings = createRemoteModelSettings(session.settings());
  let model: Awaited<ReturnType<typeof modelSettings.resolve>>;
  try {
    const snapshot = await modelSettings.snapshot();
    if (!snapshot.configured) {
      throw new CliUsageError("远程 host 尚未配置模型。先在 host 上运行 `answra config set`。");
    }
    model = await modelSettings.resolve([]);
  } catch (error) {
    session.close();
    signaling.close();
    throw error;
  }
  const store = new TuiViewStore();
  const codingHost = createRemoteControllerSessionHost({
    session,
    emitEvent: (event) => store.applyEvent(event),
    onSnapshot: (value) => store.applySnapshot(value),
  });
  const codingSession = new CodingSession({
    host: codingHost,
    conversationId: deps.createConversationId(),
    model,
    accessToken: "",
  });

  try {
    return await deps.runTui({
      session: codingSession,
      model: model.chat.model,
      store,
      modelSettings,
      modelCredentials: REMOTE_MODEL_CREDENTIALS,
      modelCatalog: EMPTY_MODEL_CATALOG,
      botName: "coding.engineer",
      workspaceRoot: welcome.workspaceRoot,
      altScreen: options.altScreen !== false,
    });
  } finally {
    codingSession.close();
    store.dispose();
    signaling.close();
  }
}

async function selectHostKey(
  remote: RemoteKeyDependencies,
  keyId: string | undefined,
  now: Date,
): Promise<RemoteHostAccessKeyRecord> {
  const records = await remote.hostKeys.list();
  if (keyId !== undefined) {
    const normalized = keyId.toLowerCase();
    const record = records.find((candidate) => candidate.keyId === normalized);
    if (record === undefined) throw new CliUsageError(`未找到访问密钥：${keyId}`);
    if (!isRemoteHostAccessKeyActive(record, now)) {
      throw new CliUsageError(`访问密钥已过期或已撤销：${keyId}`);
    }
    return record;
  }

  const active = records
    .filter((record) => isRemoteHostAccessKeyActive(record, now))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const record = active[0];
  if (record === undefined) {
    throw new CliUsageError("尚未创建有效的 host 访问密钥。先运行 `answra remote key create`。");
  }
  return record;
}

function requireRemoteRuntime(deps: CliDependencies): RemoteRuntimeDependencies {
  if (deps.remoteRuntime === undefined) throw new Error("远程运行时未配置。");
  return deps.remoteRuntime;
}

function requireInteractive(deps: CliDependencies, command: string): void {
  if (!deps.input.isTTY) {
    throw new CliUsageError(`${command} 需要交互终端，避免密钥写入日志。`);
  }
}
