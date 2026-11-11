import { render, screen } from "@testing-library/react";
import { X } from "lucide-react";
import { describe, expect, it } from "vitest";
import { IconButton } from "../src/components/controls/IconButton";
import { SurfaceButton } from "../src/components/controls/SurfaceButton";

describe("control primitives", () => {
  it("keeps SurfaceButton on the md proportion by default", () => {
    render(<SurfaceButton>确认</SurfaceButton>);

    const button = screen.getByRole("button", { name: "确认" });
    expect(button).toHaveClass("surface-control");
    expect(button).toHaveClass("surface-control--md");
    expect(button).not.toHaveClass("surface-control--icon");
  });

  it("lets SurfaceButton pick a proportion without changing its variant", () => {
    render(
      <SurfaceButton size="sm" variant="primary">
        保存
      </SurfaceButton>,
    );

    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toHaveClass("surface-control--primary");
    expect(button).toHaveClass("surface-control--sm");
  });

  it("renders IconButton as a labelled square with no text content", () => {
    render(<IconButton icon={X} label="关闭" />);

    const button = screen.getByRole("button", { name: "关闭" });
    expect(button).toHaveAttribute("aria-label", "关闭");
    expect(button).toHaveClass("surface-control--icon");
    expect(button).toHaveClass("surface-control--md");
    expect(button).toHaveTextContent("");
    expect(button.querySelector("svg")).toHaveAttribute("width", "14");
  });

  it("scales the IconButton glyph with its size token", () => {
    render(<IconButton icon={X} label="移除截图" size="xs" />);

    const button = screen.getByRole("button", { name: "移除截图" });
    expect(button).toHaveClass("surface-control--xs");
    expect(button.querySelector("svg")).toHaveAttribute("width", "12");
  });
});
