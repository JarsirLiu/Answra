import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelErrorNotice } from "../src/components/chat";

describe("ModelErrorNotice", () => {
  it("renders the failure text as an alert and hides the sign-in button by default", () => {
    render(<ModelErrorNotice message="模型服务返回 401：API Key 无效" />);

    expect(screen.getByRole("alert")).toHaveTextContent("模型服务返回 401：API Key 无效");
    expect(screen.queryByRole("button", { name: "去登录" })).not.toBeInTheDocument();
  });

  it("offers the sign-in button only when the caller supplies the action", () => {
    const onSignIn = vi.fn();
    render(<ModelErrorNotice message="请先登录后再使用（设置 → 账户）" onSignIn={onSignIn} />);

    fireEvent.click(screen.getByRole("button", { name: "去登录" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "配置本地模型" })).not.toBeInTheDocument();
  });

  it("offers both paths when the local model source is available", () => {
    const onSignIn = vi.fn();
    const onConfigureModel = vi.fn();
    render(
      <ModelErrorNotice
        message="请先登录后再使用（设置 → 账户）"
        onSignIn={onSignIn}
        onConfigureModel={onConfigureModel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "去登录" }));
    fireEvent.click(screen.getByRole("button", { name: "配置本地模型" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onConfigureModel).toHaveBeenCalledTimes(1);
  });
});
