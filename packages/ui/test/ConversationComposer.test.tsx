import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "../src/components/panels/ConversationComposer";

describe("ConversationComposer", () => {
  it("keeps editing, attachment and Enter submit callbacks available", () => {
    const onValueChange = vi.fn();
    const onAddAttachment = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ConversationComposer
        inputLabel="补充问题"
        onAddAttachment={onAddAttachment}
        onSubmit={onSubmit}
        onValueChange={onValueChange}
        placeholder="输入问题"
        value=""
      />,
    );

    const input = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "解释这道题" } });
    expect(onValueChange).toHaveBeenCalledWith("解释这道题");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    expect(onAddAttachment).toHaveBeenCalledOnce();
  });
});
