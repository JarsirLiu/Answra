import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AicssStreamingText } from "../src/components/panels/AicssConversationPrimitives";

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
