/** 当前时间上下文的纯渲染与消息追加；不读取产品状态，也不写 transcript。 */
import type { ModelMessage } from "ai";

export interface CurrentTimeContextOptions {
  readonly now?: Date;
  readonly timeZone?: string;
}

function resolveTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone?.trim() ? timeZone : "UTC";
}

function formatLocalTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("weekday")}`;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MINUTES_PER_HOUR = 60;

function formatUtcOffset(now: Date, timeZone: string): string {
  // 不解析 ICU 的 timeZoneName：同一 UTC 时区在 Windows 上输出 "UTC"，在 Linux/macOS 上输出
  // "GMT+00:00"，按字符串替换会得到两种结果。用同一时刻的本地墙上时间减 UTC 时刻算出偏移，
  // 只依赖 formatToParts 的数字部分，跨平台得到同一个规范值。
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const localWallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const utcSeconds = Math.floor(now.getTime() / MS_PER_SECOND) * MS_PER_SECOND;
  const offsetMinutes = Math.round((localWallClockAsUtc - utcSeconds) / MS_PER_MINUTE);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / MINUTES_PER_HOUR)).padStart(2, "0");
  const minutes = String(absolute % MINUTES_PER_HOUR).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function buildCurrentTimeContext({
  now = new Date(),
  timeZone = resolveTimeZone(),
}: CurrentTimeContextOptions = {}): string {
  const localTime = formatLocalTime(now, timeZone);
  const offset = formatUtcOffset(now, timeZone);
  return `<system-reminder>
# currentTime
Current local time: ${localTime} (${timeZone}, ${offset})
Current UTC time: ${now.toISOString()}
This is the current turn time. Use it as the reference for today/yesterday/tomorrow; older messages may be from earlier times. Do not infer how long ago earlier messages were sent from message order.
</system-reminder>`;
}

export function appendCurrentTimeContext(
  messages: readonly ModelMessage[],
  options: CurrentTimeContextOptions = {},
): ModelMessage[] {
  const reminder = buildCurrentTimeContext(options);
  const last = messages[messages.length - 1];
  if (last?.role !== "user") {
    return [...messages, { role: "user", content: [{ type: "text", text: reminder }] }];
  }
  return [...messages.slice(0, -1), appendText(last, reminder)];
}

function appendText(message: Extract<ModelMessage, { role: "user" }>, text: string): ModelMessage {
  const content =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
  return { ...message, content: [...content, { type: "text" as const, text }] };
}
