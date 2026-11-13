export const REMOTE_ACCESS_KEY_VERSION = "answra1";
export const REMOTE_ACCESS_KEY_DEFAULT_DAYS = 7;
export const REMOTE_ACCESS_KEY_MIN_DAYS = 7;
export const REMOTE_ACCESS_KEY_MAX_DAYS = 30;

const DAY_MS = 86_400_000;
const ROOM_ID_BYTES = 16;
const KEY_ID_BYTES = 8;
const SECRET_BYTES = 32;
const HEX_PATTERN = /^[0-9a-f]+$/;
const LABEL_MAX_LENGTH = 64;

export interface ParsedRemoteAccessKey {
  readonly version: typeof REMOTE_ACCESS_KEY_VERSION;
  readonly roomId: string;
  readonly keyId: string;
  readonly secret: string;
}

export interface GeneratedRemoteAccessKey extends ParsedRemoteAccessKey {
  readonly key: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface RemoteHostAccessKeyRecord {
  readonly roomId: string;
  readonly keyId: string;
  readonly secretHash: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

export interface RemoteCredentialRecord {
  readonly key: string;
  readonly roomId: string;
  readonly keyId: string;
  readonly label?: string;
  readonly savedAt: string;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
}

export interface GenerateRemoteAccessKeyOptions {
  readonly now?: Date;
  readonly days?: number;
}

export interface CreateRemoteHostAccessKeyRecordOptions {
  readonly label?: string;
}

export interface CreateRemoteCredentialRecordOptions {
  readonly label?: string;
  readonly savedAt?: Date;
  readonly expiresAt?: string;
}

export function parseRemoteAccessKey(input: string): ParsedRemoteAccessKey {
  const parts = input.trim().toLowerCase().split(".");
  if (parts.length !== 4) throw new Error("远程访问密钥格式无效。");
  const [version, rawRoomId, rawKeyId, rawSecret] = parts;
  if (
    version !== REMOTE_ACCESS_KEY_VERSION ||
    rawRoomId === undefined ||
    rawKeyId === undefined ||
    rawSecret === undefined
  ) {
    throw new Error("远程访问密钥格式无效。");
  }

  return {
    version: REMOTE_ACCESS_KEY_VERSION,
    roomId: parseHex(rawRoomId, ROOM_ID_BYTES, "roomId"),
    keyId: parseHex(rawKeyId, KEY_ID_BYTES, "keyId"),
    secret: parseHex(rawSecret, SECRET_BYTES, "secret"),
  };
}

export function generateRemoteAccessKey(
  options: GenerateRemoteAccessKeyOptions = {},
): GeneratedRemoteAccessKey {
  const days = resolveAccessKeyDays(options.days);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("访问密钥创建时间无效。");

  const roomId = randomHex(ROOM_ID_BYTES);
  const keyId = randomHex(KEY_ID_BYTES);
  const secret = randomHex(SECRET_BYTES);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + days * DAY_MS).toISOString();

  return {
    version: REMOTE_ACCESS_KEY_VERSION,
    roomId,
    keyId,
    secret,
    key: formatRemoteAccessKey({ roomId, keyId, secret }),
    createdAt,
    expiresAt,
  };
}

export async function createRemoteHostAccessKeyRecord(
  generated: GeneratedRemoteAccessKey,
  options: CreateRemoteHostAccessKeyRecordOptions = {},
): Promise<RemoteHostAccessKeyRecord> {
  const label = normalizeLabel(options.label);
  const secretHash = await hashRemoteAccessKeySecret(generated.secret);
  return {
    roomId: generated.roomId,
    keyId: generated.keyId,
    secretHash,
    ...(label === undefined ? {} : { label }),
    createdAt: generated.createdAt,
    expiresAt: generated.expiresAt,
  };
}

export function createRemoteCredentialRecord(
  key: string,
  options: CreateRemoteCredentialRecordOptions = {},
): RemoteCredentialRecord {
  const parsed = parseRemoteAccessKey(key);
  const savedAt = options.savedAt ?? new Date();
  if (Number.isNaN(savedAt.getTime())) throw new Error("访问密钥保存时间无效。");
  const label = normalizeLabel(options.label);
  const expiresAt =
    options.expiresAt === undefined ? undefined : normalizeTimestamp(options.expiresAt);

  return {
    key: key.trim(),
    roomId: parsed.roomId,
    keyId: parsed.keyId,
    ...(label === undefined ? {} : { label }),
    savedAt: savedAt.toISOString(),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function isRemoteHostAccessKeyActive(
  record: RemoteHostAccessKeyRecord,
  now: Date = new Date(),
): boolean {
  if (record.revokedAt !== undefined) return false;
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export async function hashRemoteAccessKeySecret(secret: string): Promise<string> {
  const normalized = parseHex(secret, SECRET_BYTES, "secret");
  const digest = await getCrypto().digest("SHA-256", asciiBytes(normalized));
  return bytesToHex(new Uint8Array(digest));
}

function formatRemoteAccessKey({
  roomId,
  keyId,
  secret,
}: Pick<ParsedRemoteAccessKey, "roomId" | "keyId" | "secret">): string {
  return `${REMOTE_ACCESS_KEY_VERSION}.${roomId}.${keyId}.${secret}`;
}

function resolveAccessKeyDays(days: number | undefined): number {
  const resolved = days ?? REMOTE_ACCESS_KEY_DEFAULT_DAYS;
  if (
    !Number.isInteger(resolved) ||
    resolved < REMOTE_ACCESS_KEY_MIN_DAYS ||
    resolved > REMOTE_ACCESS_KEY_MAX_DAYS
  ) {
    throw new Error(
      `访问密钥有效期必须是 ${REMOTE_ACCESS_KEY_MIN_DAYS}-${REMOTE_ACCESS_KEY_MAX_DAYS} 天。`,
    );
  }
  return resolved;
}

function parseHex(input: string, bytes: number, field: string): string {
  const value = input.toLowerCase();
  if (value.length !== bytes * 2 || !HEX_PATTERN.test(value)) {
    throw new Error(`远程访问密钥的 ${field} 无效。`);
  }
  return value;
}

function normalizeLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const value = label.trim();
  if (value === "") throw new Error("访问密钥标签不能为空。");
  if (value.length > LABEL_MAX_LENGTH) {
    throw new Error(`访问密钥标签不能超过 ${LABEL_MAX_LENGTH} 个字符。`);
  }
  if (hasControlCharacter(value)) throw new Error("访问密钥标签包含控制字符。");
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("访问密钥过期时间无效。");
  return timestamp.toISOString();
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return bytesToHex(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
  }
  return bytes;
}

interface CryptoProvider {
  getRandomValues(bytes: Uint8Array): Uint8Array;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function getCrypto(): CryptoProvider {
  const provider = (
    globalThis as {
      crypto?: {
        getRandomValues?: (bytes: Uint8Array) => Uint8Array;
        subtle?: {
          digest?: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
        };
      };
    }
  ).crypto;
  if (provider === undefined) {
    throw new Error("当前运行时缺少 Web Crypto，无法生成远程访问密钥。");
  }
  const getRandomValues = provider.getRandomValues;
  const subtle = provider.subtle;
  const digest = subtle?.digest;
  if (getRandomValues === undefined || subtle === undefined || digest === undefined) {
    throw new Error("当前运行时缺少 Web Crypto，无法生成远程访问密钥。");
  }
  return {
    getRandomValues: (bytes) => getRandomValues.call(provider, bytes),
    digest: (algorithm, data) => digest.call(subtle, algorithm, data),
  };
}
