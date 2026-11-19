import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { QueuedPrompts } from "../../../src/tui/transcript/QueuedPrompts";

describe("QueuedPrompts", () => {
  it("renders queued prompt text without treating it as a transcript message", () => {
    const instance = render(
      <QueuedPrompts
        prompts={[
          {
            id: "queued-1",
            text: "检查一下登录流程",
            imageCount: 2,
            status: "queued",
          },
        ]}
      />,
    );

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("已排队 · 当前回合结束后发送");
    expect(frame).toContain("检查一下登录流程");
    expect(frame).toContain("[2 张图片]");
  });

  it("marks the accepted prompt as sending until it enters the transcript", () => {
    const instance = render(
      <QueuedPrompts
        prompts={[{ id: "queued-1", text: "继续", imageCount: 0, status: "sending" }]}
      />,
    );

    expect(instance.lastFrame()).toContain("正在发送…");
    expect(instance.lastFrame()).toContain("继续");
  });

  it("renders nothing when the queue is empty", () => {
    const instance = render(<QueuedPrompts prompts={[]} />);

    expect(instance.lastFrame()).toBe("");
  });
});
