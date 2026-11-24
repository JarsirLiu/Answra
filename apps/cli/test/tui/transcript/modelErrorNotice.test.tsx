import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ModelErrorNotice } from "../../../src/tui/transcript/ModelErrorNotice";

describe("ModelErrorNotice", () => {
  it("renders the error under the response gutter", () => {
    const instance = render(<ModelErrorNotice error="model failed" />);

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("⎿");
    expect(frame).toContain("model failed");
    instance.unmount();
  });

  it("truncates long errors until transcript mode expands them", () => {
    const error = `${"x".repeat(1_200)}TAIL`;
    const collapsed = render(<ModelErrorNotice error={error} />);
    const collapsedFrame = collapsed.lastFrame() ?? "";
    expect(collapsedFrame).toContain("…");
    expect(collapsedFrame).toContain("(ctrl+o to expand)");
    expect(collapsedFrame).not.toContain("TAIL");
    collapsed.unmount();

    const expanded = render(<ModelErrorNotice error={error} expanded />);
    const expandedFrame = expanded.lastFrame() ?? "";
    expect(expandedFrame).toContain("TAIL");
    expect(expandedFrame).not.toContain("(ctrl+o to expand)");
    expanded.unmount();
  });

  it("shows one error when the same failure appears twice", () => {
    const instance = render(<ModelErrorNotice error="same failure" localError="same failure" />);

    const frame = instance.lastFrame() ?? "";
    expect(frame.split("same failure")).toHaveLength(2);
    instance.unmount();
  });

  it("explains the retry reason, HTTP status, countdown and attempt", () => {
    const instance = render(
      <ModelErrorNotice
        error="model failed"
        retry={{ kind: "rate-limit", attempt: 1, maxRetries: 5, delayMs: 5_000, statusCode: 429 }}
      />,
    );

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("请求触发限流");
    expect(frame).toContain("HTTP 429");
    expect(frame).toContain("秒后重试");
    expect(frame).toContain("1/5");
    instance.unmount();
  });

  it("marks a finished retry without a countdown", () => {
    const instance = render(
      <ModelErrorNotice
        retry={{ kind: "network-error", attempt: 2, maxRetries: 2, finished: true }}
      />,
    );

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("重试已结束");
    expect(frame).toContain("2/2");
    expect(frame).not.toContain("秒后重试");
    instance.unmount();
  });
});
