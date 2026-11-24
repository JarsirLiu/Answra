import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "../../../../src/tui/transcript/markdown/MarkdownText";

describe("MarkdownText", () => {
  it("renders a GFM table as a bordered box", () => {
    const instance = render(
      <MarkdownText text={"| Name | Score |\n| --- | ---: |\n| Alice | 10 |"} />,
    );

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("┌───────┬───────┐");
    expect(frame).toContain("│ Alice │    10 │");
    expect(frame).toContain("└───────┴───────┘");
    instance.unmount();
  });

  it("keeps fenced code out of table parsing", () => {
    const instance = render(<MarkdownText text={"```ts\na | b\n```"} />);

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ts");
    expect(frame).toContain("a | b");
    expect(frame).not.toContain("┌");
    instance.unmount();
  });
});
