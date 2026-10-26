import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThinkingReasoning } from "../src/components/chat/ThinkingReasoning";

describe("ThinkingReasoning", () => {
  it("collapses to the latest streaming line and expands on demand", () => {
    const { container } = render(
      <ThinkingReasoning reasoning={"First thought\nSecond thought"} thinking={true} />,
    );
    const toggle = screen.getByRole("button", { name: "切换思考过程" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("思考中…")).toBeInTheDocument();
    expect(screen.getByText("Second thought")).toBeInTheDocument();
    expect(screen.queryByText("First thought")).not.toBeInTheDocument();
    expect(container.querySelector('[class*="trBody"]')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("First thought")).toBeInTheDocument();
    expect(screen.getByText("Second thought")).toBeInTheDocument();
    expect(container.querySelector('[class*="trBody"]')).not.toBeNull();
  });

  it("follows the stream end while thinking, then drops the summary when finished", () => {
    const { rerender } = render(
      <ThinkingReasoning reasoning={"First thought\nLatest"} thinking={true} />,
    );
    const summary = screen.getByText("Latest");
    Object.defineProperties(summary, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
    });

    rerender(<ThinkingReasoning reasoning={"First thought\nLatest tokens"} thinking={true} />);
    expect(summary.scrollLeft).toBe(200);

    rerender(
      <ThinkingReasoning
        durationMs={4200}
        reasoning={"First thought\nLatest tokens"}
        thinking={false}
      />,
    );

    expect(screen.queryByText("First thought")).not.toBeInTheDocument();
    expect(screen.queryByText("Latest tokens")).not.toBeInTheDocument();
    expect(document.querySelector('[class*="trLabel"]')?.textContent).toBe("已思考 4 秒");
  });
});
