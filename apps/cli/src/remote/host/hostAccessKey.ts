/** host 访问密钥的创建与 active 选择；不负责打印或持久化路径。 */
import {
  createRemoteHostAccessKeyRecord,
  type GeneratedRemoteAccessKey,
  generateRemoteAccessKey,
  isRemoteHostAccessKeyActive,
  type RemoteHostAccessKeyRecord,
  type RemoteHostKeyStore,
} from "@answra/remote";

export interface CreateHostAccessKeyOptions {
  hostKeys: RemoteHostKeyStore;
  now: Date;
  days?: number;
  label?: string;
  permanent?: boolean;
  purpose?: "connection-code";
}

export interface CreatedHostAccessKey {
  record: RemoteHostAccessKeyRecord;
  generated: GeneratedRemoteAccessKey;
}

export interface EnsuredHostAccessKey {
  record: RemoteHostAccessKeyRecord;
  created?: CreatedHostAccessKey;
}

export async function createHostAccessKey({
  hostKeys,
  now,
  days,
  label,
  permanent,
  purpose,
}: CreateHostAccessKeyOptions): Promise<CreatedHostAccessKey> {
  const generated = generateRemoteAccessKey({
    now,
    ...(days === undefined ? {} : { days }),
    ...(permanent === undefined ? {} : { permanent }),
  });
  const record = await createRemoteHostAccessKeyRecord(generated, {
    ...(label === undefined ? {} : { label }),
    ...(purpose === undefined ? {} : { purpose }),
  });
  await hostKeys.save(record);
  return { record, generated };
}

/** 已有 active key 时复用；否则在允许创建时生成默认 7 天密钥。 */
export async function ensureActiveHostAccessKey({
  hostKeys,
  now,
  allowCreate,
}: {
  hostKeys: RemoteHostKeyStore;
  now: Date;
  allowCreate: boolean;
}): Promise<EnsuredHostAccessKey> {
  const records = await hostKeys.list();
  const active = records.find((record) => isRemoteHostAccessKeyActive(record, now));
  if (active !== undefined) return { record: active };
  if (!allowCreate) {
    throw new Error("没有有效的远程访问密钥；请先运行 `answra remote key create`。");
  }
  const created = await createHostAccessKey({ hostKeys, now });
  return { record: created.record, created };
}

export function formatCreatedHostAccessKey(created: CreatedHostAccessKey): string {
  return [
    "远程访问密钥已生成（只显示这一次）：",
    created.generated.key,
    "",
    `Key ID: ${created.record.keyId}`,
    `Expires: ${created.record.expiresAt}`,
    "",
    "在 controller 上运行 `answra remote key set` 并粘贴此密钥。",
    "",
  ].join("\n");
}
