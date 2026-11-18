/** 厂商扩展请求参数的本地入口：只接受普通对象，序列化后超过 4 KB 视为无效。 */
const MAX_PROVIDER_OPTIONS_BYTES = 4096;

export function readProviderOptions(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_OPTIONS_BYTES
  ) {
    return undefined;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
