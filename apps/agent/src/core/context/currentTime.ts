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

function formatUtcOffset(now: Date, timeZone: string): string {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;
  return offset ? offset.replace(/^GMT/u, "UTC") : "UTC+00:00";
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
