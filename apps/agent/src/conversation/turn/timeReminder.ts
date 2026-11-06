/** 为显式开启时间上下文的 profile 构造注入到最后一条用户消息的时间提醒。 */

function formatLocalTime(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const tz = get("timeZoneName");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}${
    tz ? ` (${tz})` : ""
  }`;
}

export function buildTimeReminder(): string {
  return `<system-reminder>\n# currentDate\nCurrent date and time is ${formatLocalTime()}.\n</system-reminder>`;
}
