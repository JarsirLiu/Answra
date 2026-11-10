import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextResponse } from "../src/components/chat/TextResponse";

let previousClipboard: PropertyDescriptor | undefined;

function setClipboard(writeText: ReturnType<typeof vi.fn>) {
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  previousClipboard = undefined;
});

describe("TextResponse markdown", () => {
  it("renders GFM tables and fenced code blocks as markdown structures", () => {
    const { container } = render(
      <TextResponse
        text={"## 示例表格\n\n| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 25 |\n\n```ts\nconst answer = 42;\n```"}
      />,
    );

    expect(screen.getByRole("heading", { name: "示例表格" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table.parentElement?.className).toContain("tableScroll");
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("ts")).toBeInTheDocument();
    expect(container.querySelector("pre code")?.textContent).toBe("const answer = 42;");
  });
});

describe("TextResponse code blocks", () => {
  it("shows a copy button in the code block header and copies code without the markdown trailing newline", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<TextResponse text={"```typescript\nconst answer = 42;\n```"} />);

    const codeBlock = document.querySelector("[class*='codeBlock']");
    expect(codeBlock).not.toBeNull();
    expect(codeBlock).toContainElement(screen.getByText("typescript"));

    const copy = screen.getByRole("button", { name: "复制代码" });
    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const answer = 42;"));
    expect(await screen.findByRole("button", { name: "已复制代码" })).toBeInTheDocument();
    expect(screen.getByText("已复制").tagName).toBe("SPAN");
  });
});
