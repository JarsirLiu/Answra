import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { RetryNotice } from "../../../src/tui/transcript/RetryNotice";

describe("RetryNotice", () => {
  it("shows the retry reason, HTTP status, countdown, and attempt", () => {
    const instance = render(
      <RetryNotice
        retry={{
          kind: "rate-limit",
          attempt: 1,
          maxRetries: 5,
          delayMs: 5_000,
          statusCode: 429,
        }}
      />,
    );

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("请求触发限流");
    expect(frame).toContain("HTTP 429");
    expect(frame).toContain("5 秒后重试");
    expect(frame).toContain("1/5");
    instance.unmount();
  });

  it("marks a finished retry without a countdown", () => {
    const instance = render(
      <RetryNotice retry={{ kind: "network-error", attempt: 2, maxRetries: 2, finished: true }} />,
    );

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("重试已结束");
    expect(frame).not.toContain("正在重试");
    instance.unmount();
  });
});
