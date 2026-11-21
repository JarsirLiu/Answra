/** CLI 远程 host 命令：启动常驻 host、生成连接码并管理 host 访问密钥。 */
import { isRemoteHostAccessKeyActive, type RemoteHostAccessKeyRecord } from "@answra/remote";
import {
  type RemoteHostHandle,
  type RemoteRuntimeDependencies,
  startRemoteHost,
} from "@answra/remote-node";
import { CLI_API_KEY } from "@answra/shared";
import type { CliOptions } from "../config/cliOptions";
import { resolveWorkspaceRoot } from "../config/workspace";
import { resolveModelAccessToken } from "../model/accessToken";
import { createRemoteCodingHost } from "../remote/host/commandPort";
import { createHostAccessKey } from "../remote/host/hostAccessKey";
import type { CliDependencies, RemoteKeyDependencies } from "./dependencies";
import { CliUsageError } from "./errors";

type RemoteOptions = Extract<CliOptions, { kind: "remote" }>;

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
