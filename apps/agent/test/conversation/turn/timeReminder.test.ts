import { describe, expect, it } from "vitest";
import { buildTimeReminder } from "../../../src/conversation/turn/timeReminder";

describe("conversation time reminder", () => {
  it("reports the local time, IANA time zone, offset, and UTC time", () => {
    const reminder = buildTimeReminder({
      now: new Date("2026-11-10T06:32:00.000Z"),
      timeZone: "Asia/Shanghai",
    });

    expect(reminder).toContain(
      "Current local time: 2026-11-10 14:32 星期二 (Asia/Shanghai, UTC+08:00)",
    );
    expect(reminder).toContain("Current UTC time: 2026-11-10T06:32:00.000Z");
    expect(reminder).toContain("Do not infer how long ago earlier messages were sent");
    expect(reminder).not.toContain("Last user message");
  });

  it("uses the daylight-saving offset for the supplied instant", () => {
    const summer = buildTimeReminder({
      now: new Date("2026-07-01T12:00:00.000Z"),
      timeZone: "America/New_York",
    });
    const winter = buildTimeReminder({
      now: new Date("2026-01-15T12:00:00.000Z"),
      timeZone: "America/New_York",
    });

    expect(summer).toContain(
      "Current local time: 2026-07-01 08:00 星期三 (America/New_York, UTC-04:00)",
    );
    expect(winter).toContain(
      "Current local time: 2026-01-15 07:00 星期四 (America/New_York, UTC-05:00)",
    );
  });

  it("formats UTC without a misleading local time zone abbreviation", () => {
    const reminder = buildTimeReminder({
      now: new Date("2026-11-10T06:32:00.000Z"),
      timeZone: "UTC",
    });

    expect(reminder).toContain("Current local time: 2026-11-10 06:32 星期二 (UTC, UTC+00:00)");
  });

  it("recomputes the reminder for each call", () => {
    const first = buildTimeReminder({
      now: new Date("2026-11-10T06:32:00.000Z"),
      timeZone: "Asia/Shanghai",
    });
    const second = buildTimeReminder({
      now: new Date("2026-11-10T07:32:00.000Z"),
      timeZone: "Asia/Shanghai",
    });

    expect(first).toContain("2026-11-10 14:32");
    expect(second).toContain("2026-11-10 15:32");
    expect(second).not.toContain("2026-11-10 14:32");
  });
});
