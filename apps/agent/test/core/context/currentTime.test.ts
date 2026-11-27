import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  appendCurrentTimeContext,
  buildCurrentTimeContext,
} from "../../../src/core/context/currentTime";

const FIXED_TIME = {
  now: new Date("2026-11-10T06:32:00.000Z"),
  timeZone: "Asia/Shanghai",
};

describe("current time context", () => {
  it("reports the local time, IANA time zone, offset, and UTC time", () => {
    const reminder = buildCurrentTimeContext(FIXED_TIME);

    expect(reminder).toContain(
      "Current local time: 2026-11-10 14:32 星期二 (Asia/Shanghai, UTC+08:00)",
    );
    expect(reminder).toContain("Current UTC time: 2026-11-10T06:32:00.000Z");
    expect(reminder).toContain("Do not infer how long ago earlier messages were sent");
    expect(reminder).not.toContain("Last user message");
  });

  it("uses the daylight-saving offset for the supplied instant", () => {
    const summer = buildCurrentTimeContext({
      now: new Date("2026-07-01T12:00:00.000Z"),
      timeZone: "America/New_York",
    });
    const winter = buildCurrentTimeContext({
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
    const reminder = buildCurrentTimeContext({
      now: new Date("2026-11-10T06:32:00.000Z"),
      timeZone: "UTC",
    });

    expect(reminder).toContain("Current local time: 2026-11-10 06:32 星期二 (UTC, UTC+00:00)");
  });

  it("formats fractional and negative offsets as canonical UTC±HH:MM values", () => {
    const kolkata = buildCurrentTimeContext({
      now: new Date("2026-11-10T06:32:00.000Z"),
      timeZone: "Asia/Kolkata",
    });
    const losAngeles = buildCurrentTimeContext({
      now: new Date("2026-11-10T02:00:00.000Z"),
      timeZone: "America/Los_Angeles",
    });

    expect(kolkata).toContain(
      "Current local time: 2026-11-10 12:02 星期二 (Asia/Kolkata, UTC+05:30)",
    );
    // 本地日期落到前一天时，偏移仍由同一时刻的差值决定，而不是从日期字符串推断。
    expect(losAngeles).toContain(
      "Current local time: 2026-11-09 18:00 星期一 (America/Los_Angeles, UTC-08:00)",
    );
  });

  it("recomputes the reminder for each call", () => {
    const first = buildCurrentTimeContext(FIXED_TIME);
    const second = buildCurrentTimeContext({
      now: new Date("2026-11-10T07:32:00.000Z"),
      timeZone: "Asia/Shanghai",
    });

    expect(first).toContain("2026-11-10 14:32");
    expect(second).toContain("2026-11-10 15:32");
    expect(second).not.toContain("2026-11-10 14:32");
  });

  it("appends the reminder to the last user message without mutating the input", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "现在几点？" }];

    const result = appendCurrentTimeContext(messages, FIXED_TIME);

    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "现在几点？" },
          { type: "text", text: buildCurrentTimeContext(FIXED_TIME) },
        ],
      },
    ]);
    expect(messages).toEqual([{ role: "user", content: "现在几点？" }]);
  });

  it("keeps existing user parts and adds one reminder part", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", image: new Uint8Array([1]), mediaType: "image/png" },
        ],
      },
    ];

    const result = appendCurrentTimeContext(messages, FIXED_TIME);

    const content = result[0]?.role === "user" ? result[0].content : undefined;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(3);
    expect(content && Array.isArray(content) ? content[2] : undefined).toMatchObject({
      type: "text",
      text: expect.stringContaining("# currentTime"),
    });
  });

  it("adds a user reminder when the last message is not from the user", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: "稍等" }];

    const result = appendCurrentTimeContext(messages, FIXED_TIME);

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: buildCurrentTimeContext(FIXED_TIME) }],
    });
  });
});
