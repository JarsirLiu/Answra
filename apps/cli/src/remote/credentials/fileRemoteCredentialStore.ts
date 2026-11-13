import { rm } from "node:fs/promises";
import path from "node:path";
import { resolveDefaultConfigDir } from "@answra/config";
import {
  parseRemoteAccessKey,
  type RemoteCredentialRecord,
  type RemoteCredentialStore,
} from "@answra/remote";
import { readProtectedJson, writeProtectedJson } from "./jsonFile";

const FILE_VERSION = 1;

interface CredentialFile {
  readonly version: typeof FILE_VERSION;
  readonly credential: RemoteCredentialRecord | null;
}

export function createFileRemoteCredentialStore(
  filePath: string = defaultRemoteCredentialPath(),
): RemoteCredentialStore {
  return {
    async read() {
      return (await load(filePath)).credential;
    },
    async write(record) {
      await writeProtectedJson(filePath, {
        version: FILE_VERSION,
        credential: cloneRecord(record),
      });
    },
    async delete() {
      await rm(filePath, { force: true });
    },
  };
}

export function defaultRemoteCredentialPath(): string {
  return path.join(resolveDefaultConfigDir(), "remote", "controller.json");
}

async function load(filePath: string): Promise<CredentialFile> {
  return parseCredentialFile(await readProtectedJson(filePath));
}

function parseCredentialFile(value: unknown): CredentialFile {
  if (value === null) return { version: FILE_VERSION, credential: null };
  if (!isRecord(value) || value.version !== FILE_VERSION) {
    throw new Error("远程 controller 密钥文件格式无效。");
  }
  if (value.credential === null) return { version: FILE_VERSION, credential: null };
  return { version: FILE_VERSION, credential: parseCredential(value.credential) };
}

function parseCredential(value: unknown): RemoteCredentialRecord {
  if (!isRecord(value)) throw new Error("远程 controller 密钥记录格式无效。");
  const key = readString(value.key, "key");
  const parsed = parseRemoteAccessKey(key);
  const roomId = readString(value.roomId, "roomId");
  const keyId = readString(value.keyId, "keyId");
  if (roomId !== parsed.roomId || keyId !== parsed.keyId) {
    throw new Error("远程 controller 密钥记录与 key 不一致。");
  }
  const label = optionalString(value.label, "label");
  const savedAt = normalizeTimestamp(readString(value.savedAt, "savedAt"));
  const expiresAt = optionalTimestamp(value.expiresAt, "expiresAt");
  const lastUsedAt = optionalTimestamp(value.lastUsedAt, "lastUsedAt");
  return {
    key,
    roomId,
    keyId,
    ...(label === undefined ? {} : { label }),
    savedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  };
}

function cloneRecord(record: RemoteCredentialRecord): RemoteCredentialRecord {
  return { ...record };
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} 无效。`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, field);
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return normalizeTimestamp(readString(value, field));
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("远程 controller 密钥时间无效。");
  return timestamp.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
