import path from "node:path";
import { resolveDefaultConfigDir } from "@answra/config";
import type { RemoteHostAccessKeyRecord, RemoteHostKeyStore } from "@answra/remote";
import { readProtectedJson, writeProtectedJson } from "./jsonFile";

const FILE_VERSION = 1;
const HEX_HASH_PATTERN = /^[0-9a-f]{64}$/;

interface HostKeyFile {
  readonly version: typeof FILE_VERSION;
  readonly keys: readonly RemoteHostAccessKeyRecord[];
}

export function createFileRemoteHostKeyStore(
  filePath: string = defaultRemoteHostKeyPath(),
): RemoteHostKeyStore {
  let pending: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<HostKeyFile> =>
    parseHostKeyFile(await readProtectedJson(filePath));

  return {
    async list() {
      return (await load()).keys;
    },
    async getByKeyId(keyId) {
      return (await load()).keys.find((record) => record.keyId === keyId) ?? null;
    },
    save(record) {
      return withLock(async () => {
        const current = await load();
        const keys = [
          ...current.keys.filter((existing) => existing.keyId !== record.keyId),
          cloneRecord(record),
        ];
        await writeProtectedJson(filePath, { version: FILE_VERSION, keys });
      });
    },
    revoke(keyId, revokedAt) {
      return withLock(async () => {
        const current = await load();
        const index = current.keys.findIndex((record) => record.keyId === keyId);
        if (index < 0) return false;
        const keys = current.keys.map((record, recordIndex) =>
          recordIndex === index
            ? { ...record, revokedAt: record.revokedAt ?? normalizeTimestamp(revokedAt) }
            : record,
        );
        await writeProtectedJson(filePath, { version: FILE_VERSION, keys });
        return true;
      });
    },
  };

  function withLock<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(action, action);
    pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export function defaultRemoteHostKeyPath(): string {
  return path.join(resolveDefaultConfigDir(), "remote", "host-keys.json");
}

function parseHostKeyFile(value: unknown): HostKeyFile {
  if (value === null) return { version: FILE_VERSION, keys: [] };
  if (!isRecord(value) || value.version !== FILE_VERSION || !Array.isArray(value.keys)) {
    throw new Error("远程 host 密钥文件格式无效。");
  }
  return { version: FILE_VERSION, keys: value.keys.map(parseHostKeyRecord) };
}

function parseHostKeyRecord(value: unknown): RemoteHostAccessKeyRecord {
  if (!isRecord(value)) throw new Error("远程 host 密钥记录格式无效。");
  const roomId = readHex(value.roomId, 32, "roomId");
  const keyId = readHex(value.keyId, 16, "keyId");
  const secretHash = readString(value.secretHash, "secretHash");
  if (!HEX_HASH_PATTERN.test(secretHash)) throw new Error("远程 host 密钥哈希无效。");
  const label = optionalString(value.label, "label");
  const purpose = readPurpose(value.purpose);
  const createdAt = readTimestamp(value.createdAt, "createdAt");
  const expiresAt = optionalTimestamp(value.expiresAt, "expiresAt");
  const lastUsedAt = optionalTimestamp(value.lastUsedAt, "lastUsedAt");
  const revokedAt = optionalTimestamp(value.revokedAt, "revokedAt");
  return {
    roomId,
    keyId,
    secretHash,
    ...(label === undefined ? {} : { label }),
    ...(purpose === undefined ? {} : { purpose }),
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function readPurpose(value: unknown): "connection-code" | undefined {
  if (value === undefined) return undefined;
  if (value !== "connection-code") throw new Error("远程 host 密钥用途无效。");
  return value;
}

function cloneRecord(record: RemoteHostAccessKeyRecord): RemoteHostAccessKeyRecord {
  return { ...record };
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} 无效。`);
  return value;
}

function readHex(value: unknown, length: number, field: string): string {
  const text = readString(value, field);
  if (text.length !== length || !/^[0-9a-f]+$/.test(text)) throw new Error(`${field} 无效。`);
  return text;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, field);
}

function readTimestamp(value: unknown, field: string): string {
  const text = readString(value, field);
  return normalizeTimestamp(text);
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readTimestamp(value, field);
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("远程 host 密钥时间无效。");
  return timestamp.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
