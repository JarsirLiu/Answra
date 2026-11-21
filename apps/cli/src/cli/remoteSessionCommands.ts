/** CLI 远程会话命令：host 常驻与 controller attach 的组合接线。 */
import type { ModelCredentialStore } from "@answra/credentials";
import {
  createRemoteCredentialRecord,
  isRemoteHostAccessKeyActive,
  RemoteControllerConnection,
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
import { createHostAccessKey } from "../remote/host/hostAccessKey";
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

export interface RemoteHostConnectionCode {
  readonly code?: string;
  readonly keyId: string;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export async function startRemoteHostWithConnectionCode(
  deps: CliDependencies,
  workspaceRoot: string,
  onStatus: (line: string) => void,
): Promise<RemoteHostConnectionCode> {
  const remote = requireRemoteKeys(deps);
  const runtime = requireRemoteRuntime(deps);
  if (deps.remoteAuth === undefined) {
    throw new CliUsageError("当前环境未配置账号登录，无法开启远程连接。");
  }
  await deps.remoteAuth.getAccessToken();
  const modelSnapshot = await deps.modelSettings.snapshot();
  if (!modelSnapshot.configured) {
    throw new CliUsageError("请先用 /config 配置本机模型，再开启远程连接。");
  }
  const accessToken = await resolveModelAccessToken(deps.env[CLI_API_KEY], deps.modelCredentials);
  const now = remote.now?.() ?? new Date();
  const existing = (await remote.hostKeys.list()).find(
    (record) =>
      record.purpose === "connection-code" &&
      record.expiresAt === undefined &&
      isRemoteHostAccessKeyActive(record, now),
  );
  const created =
    existing === undefined
      ? await createHostAccessKey({
          hostKeys: remote.hostKeys,
          now,
          permanent: true,
          label: "CLI connection code",
          purpose: "connection-code",
        })
      : undefined;
  const record = created?.record ?? existing;
  if (record === undefined) throw new Error("无法创建远程连接码。");
  const createHost = deps.createRemoteHost ?? createRemoteCodingHost;
  const host = createHost({ workspaceRoot, modelSettings: deps.modelSettings, accessToken });

  try {
    const handle = await startRemoteHost({
      runtime,
      hostKeys: remote.hostKeys,
      host: host.port,
      workspaceRoot,
      roomId: record.roomId,
      onStatus,
    });
    return {
      ...(created === undefined ? {} : { code: created.generated.key }),
      keyId: record.keyId,
      done: handle.done,
      stop: async () => {
        try {
          await handle.stop();
        } finally {
          host.dispose();
        }
      },
    };
  } catch (error) {
    host.dispose();
    if (created !== undefined) {
      await remote.hostKeys.revoke(
        created.record.keyId,
        (remote.now?.() ?? new Date()).toISOString(),
      );
    }
    throw error;
  }
}

export async function runRemoteAttachCommand(
  options: Extract<RemoteOptions, { action: "attach" }>,
  remote: RemoteKeyDependencies,
  deps: CliDependencies,
  now: Date,
): Promise<number> {
  requireInteractive(deps, "remote attach");
  const runtime = requireRemoteRuntime(deps);
  let credential = await remote.credentials.read();
  let enteredCredential = false;
  if (credential === null) {
    const code = await remote.promptSecret("输入远程连接码：");
    try {
      credential = createRemoteCredentialRecord(code, { savedAt: now });
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : "远程连接码格式无效。");
    }
    enteredCredential = true;
  }
  if (credential.expiresAt !== undefined) {
    const expiresAt = Date.parse(credential.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      throw new CliUsageError("保存的 controller 密钥已过期。先在 host 上重新生成并运行 key set。");
    }
  }

  const peerId = runtime.createId();
  const connection = new RemoteControllerConnection({
    timers: runtime.timers,
    createAttempt: async () => {
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
      const unsubscribeSignaling = signaling.onState((state) => {
        if (state === "closed") session.close();
      });
      return {
        session,
        close() {
          unsubscribeSignaling();
          session.close();
          signaling.close();
        },
      };
    },
  });

  let welcome: Awaited<ReturnType<RemoteControllerSession["connect"]>>;
  const removeInterrupt = deps.onInterrupt(() => connection.close());
  try {
    welcome = await connection.connect();
    if (enteredCredential) await remote.credentials.write(credential);
  } catch (error) {
    connection.close();
    throw error;
  } finally {
    removeInterrupt();
  }

  const modelSettings = createRemoteModelSettings(connection.settings());
  let model: Awaited<ReturnType<typeof modelSettings.resolve>>;
  try {
    const snapshot = await modelSettings.snapshot();
    if (!snapshot.configured) {
      throw new CliUsageError("远程 host 尚未配置模型。先在 host 上运行 `answra config set`。");
    }
    model = await modelSettings.resolve([]);
  } catch (error) {
    connection.close();
    throw error;
  }
  const store = new TuiViewStore();
  const codingHost = createRemoteControllerSessionHost({
    session: connection,
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
    connection.close();
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

function requireRemoteKeys(deps: CliDependencies): RemoteKeyDependencies {
  if (deps.remoteKeys === undefined) throw new Error("远程密钥依赖未注入。");
  return deps.remoteKeys;
}

function requireInteractive(deps: CliDependencies, command: string): void {
  if (!deps.input.isTTY) {
    throw new CliUsageError(`${command} 需要交互终端，避免密钥写入日志。`);
  }
}
