import {
  createRemoteCredentialRecord,
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  isRemoteHostAccessKeyActive,
} from "@answra/remote";
import type { CliOptions } from "../config/cliOptions";
import type { CliDependencies, RemoteKeyDependencies } from "./dependencies";
import { CliUsageError } from "./errors";

type RemoteOptions = Extract<CliOptions, { kind: "remote" }>;

export const REMOTE_HELP = `Answra Remote

用法:
  answra remote key create [--days 7|30] [--label <名称>]
  answra remote key list
  answra remote key revoke <keyId>
  answra remote key set
  answra remote key show
  answra remote key forget
  answra remote --help

命令:
  key create   在 host 上生成访问密钥；密钥只显示一次
  key list     列出 host 上的密钥状态，不显示 secret
  key revoke   撤销 host 上的密钥
  key set      粘贴 controller 访问密钥并保存到本机
  key show     查看本机已保存的 controller 密钥摘要
  key forget   删除本机保存的 controller 密钥

说明:
  访问密钥只通过终端输入，不接受命令行参数，不写入 shell 历史。
  host 密钥文件只保存 secret 的哈希；controller 保存完整 key 以便重连。
  remote host/attach 还需要先运行 answra auth login 获取服务准入凭据。
`;

export async function runRemoteCommand(
  options: RemoteOptions,
  deps: CliDependencies,
): Promise<number> {
  if (options.action === "help") {
    deps.output.write(REMOTE_HELP);
    return 0;
  }

  const remote = deps.remoteKeys;
  if (remote === undefined) throw new Error("远程密钥命令依赖未注入。");

  const now = remote.now?.() ?? new Date();
  switch (options.action) {
    case "key-create":
      requireInteractive(deps, "remote key create");
      await createKey(options, remote, deps, now);
      return 0;
    case "key-list":
      await listKeys(remote, deps, now);
      return 0;
    case "key-revoke":
      await revokeKey(options.keyId, remote, deps, now);
      return 0;
    case "key-set":
      await setKey(remote, deps, now);
      return 0;
    case "key-show":
      await showKey(remote, deps);
      return 0;
    case "key-forget":
      await forgetKey(remote, deps);
      return 0;
  }
}

async function createKey(
  options: Extract<RemoteOptions, { action: "key-create" }>,
  remote: RemoteKeyDependencies,
  deps: CliDependencies,
  now: Date,
): Promise<void> {
  let generated: ReturnType<typeof generateRemoteAccessKey>;
  let record: Awaited<ReturnType<typeof createRemoteHostAccessKeyRecord>>;
  try {
    generated = generateRemoteAccessKey({
      now,
      ...(options.days === undefined ? {} : { days: options.days }),
    });
    record = await createRemoteHostAccessKeyRecord(generated, {
      ...(options.label === undefined ? {} : { label: options.label }),
    });
  } catch (error) {
    throw new CliUsageError(messageOf(error));
  }
  await remote.hostKeys.save(record);

  deps.output.write(
    [
      "访问密钥已生成（只显示这一次）：",
      generated.key,
      "",
      `Key ID: ${record.keyId}`,
      `Label: ${record.label ?? "-"}`,
      `Expires: ${record.expiresAt}`,
      "",
      "在 controller 上运行 `answra remote key set` 并粘贴此密钥。",
      "任何持有该密钥的人都可以控制此 host。",
      "",
    ].join("\n"),
  );
}

async function listKeys(
  remote: RemoteKeyDependencies,
  deps: CliDependencies,
  now: Date,
): Promise<void> {
  const records = await remote.hostKeys.list();
  if (records.length === 0) {
    deps.output.write("尚未创建远程访问密钥。\n");
    return;
  }

  const lines = ["KEY ID           LABEL            EXPIRES                   STATUS"];
  for (const record of records) {
    const status = isRemoteHostAccessKeyActive(record, now)
      ? "active"
      : record.revokedAt === undefined
        ? "expired"
        : "revoked";
    lines.push(
      `${record.keyId}  ${(record.label ?? "-").padEnd(15)}  ${record.expiresAt}  ${status}`,
    );
  }
  deps.output.write(`${lines.join("\n")}\n`);
}

async function revokeKey(
  keyId: string,
  remote: RemoteKeyDependencies,
  deps: CliDependencies,
  now: Date,
): Promise<void> {
  const revoked = await remote.hostKeys.revoke(keyId.toLowerCase(), now.toISOString());
  if (!revoked) throw new CliUsageError(`未找到访问密钥：${keyId}`);
  deps.output.write(`已撤销访问密钥：${keyId.toLowerCase()}\n`);
}

async function setKey(
  remote: RemoteKeyDependencies,
  deps: CliDependencies,
  now: Date,
): Promise<void> {
  const key = await remote.promptSecret("Paste access key: ");
  let credential: ReturnType<typeof createRemoteCredentialRecord>;
  try {
    credential = createRemoteCredentialRecord(key, { savedAt: now });
  } catch (error) {
    throw new CliUsageError(messageOf(error));
  }
  await remote.credentials.write(credential);
  deps.output.write(`已保存 controller 密钥：${credential.keyId}\n`);
}

async function showKey(remote: RemoteKeyDependencies, deps: CliDependencies): Promise<void> {
  const credential = await remote.credentials.read();
  if (credential === null) {
    deps.output.write("未保存 controller 密钥。\n");
    return;
  }
  deps.output.write(
    [
      "Controller 密钥",
      `Key ID: ${credential.keyId}`,
      `Room ID: ${credential.roomId}`,
      `Label: ${credential.label ?? "-"}`,
      `Saved: ${credential.savedAt}`,
      `Expires: ${credential.expiresAt ?? "未知（连接 host 后更新）"}`,
      "",
    ].join("\n"),
  );
}

async function forgetKey(remote: RemoteKeyDependencies, deps: CliDependencies): Promise<void> {
  await remote.credentials.delete();
  deps.output.write("已删除 controller 密钥。\n");
}

function requireInteractive(deps: CliDependencies, command: string): void {
  if (!deps.input.isTTY) {
    throw new CliUsageError(`${command} 需要交互终端，避免密钥写入日志。`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "访问密钥格式无效。";
}
