import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AicssMarkdown,
  AicssStreamingText,
  AicssThinkingReasoning,
} from "../src/components/panels/AicssConversationPrimitives";

describe("conversation Markdown", () => {
  it("renders thinking text with Markdown and GFM", () => {
    render(
      <AicssThinkingReasoning
        isActive={false}
        text={"**关键结论** 和 `x + 1`\n\n- 第一项\n- 第二项"}
      />,
    );

    expect(screen.getByText("关键结论").tagName).toBe("STRONG");
    expect(screen.getByText("x + 1").tagName).toBe("CODE");
    expect(screen.getByText("第一项").tagName).toBe("LI");
  });

  it("renders incomplete Markdown prefixes without requiring completion", () => {
    const { rerender } = render(<AicssMarkdown text="**bold" />);
    expect(screen.getByText("**bold")).toBeInTheDocument();

    rerender(<AicssMarkdown text="**bold**" />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });
});

describe("AicssStreamingText", () => {
  afterEach(() => vi.useRealTimers());

  it("reveals from the paragraph start and appends new deltas without replaying its prefix", () => {
    vi.useFakeTimers();
    const renderText = (visibleText: string) => <p>{visibleText}</p>;
    const onReveal = vi.fn();
    const { rerender } = render(
      <AicssStreamingText onReveal={onReveal} render={renderText} streaming text="" />,
    );

    rerender(
      <AicssStreamingText onReveal={onReveal} render={renderText} streaming text="abcdef" />,
    );
    act(() => vi.advanceTimersByTime(9));
    expect(screen.getByText("ab")).toBeInTheDocument();

    rerender(
      <AicssStreamingText onReveal={onReveal} render={renderText} streaming text="abcdefghij" />,
    );
    act(() => vi.advanceTimersByTime(9));
    expect(screen.getByText("abcd")).toBeInTheDocument();
    expect(onReveal).toHaveBeenCalledTimes(2);
  });

  it("removes the streaming caret once the message is complete", () => {
    const renderText = (visibleText: string) => <p>{visibleText}</p>;
    const { rerender } = render(
      <AicssStreamingText onReveal={() => undefined} render={renderText} streaming text="答案" />,
    );

    expect(document.querySelector(".aicss-streaming-caret")).toBeInTheDocument();
    rerender(
      <AicssStreamingText
        onReveal={() => undefined}
        render={renderText}
        streaming={false}
        text="答案"
      />,
    );
    expect(document.querySelector(".aicss-streaming-caret")).not.toBeInTheDocument();
  });
});
