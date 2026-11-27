import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewIntakePanel } from "../src/interview/intake/InterviewIntakePanel";
import { createConversationBridge, resetFloatingBarTestState } from "./support/floatingBarHarness";

const IMAGE_DATA_URL = "data:image/png;base64,QUJD";

function renderIntake(): ReturnType<typeof createConversationBridge> {
  const bridge = createConversationBridge();
  render(
    <InterviewIntakePanel
      onBackToModes={() => undefined}
      onClose={() => undefined}
      onReopenOnboarding={vi.fn(async () => undefined)}
      platform={bridge}
    />,
  );
  return bridge;
}

function pasteImage(input: HTMLElement, file: File): void {
  fireEvent.paste(input, { clipboardData: { files: [file] } });
}

describe("interview intake image input", () => {
  beforeEach(() => {
    resetFloatingBarTestState();
  });

  it("previews a pasted screenshot and sends it with the message", async () => {
    vi.mocked(URL.createObjectURL).mockReturnValue(IMAGE_DATA_URL);
    const bridge = renderIntake();

    const input = await screen.findByLabelText("输入消息");
    pasteImage(input, new File(["png"], "简历截图.png", { type: "image/png" }));

    expect(await screen.findByAltText("待发送截图预览")).toHaveAttribute("src", IMAGE_DATA_URL);
    expect(screen.getByText("简历截图.png")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "这是我的简历截图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(bridge.sendInterviewIntakeMessage).toHaveBeenCalledOnce());
    expect(bridge.sendInterviewIntakeMessage).toHaveBeenCalledWith("这是我的简历截图", [
      { name: "简历截图.png", dataUrl: IMAGE_DATA_URL },
    ]);
    await waitFor(() => expect(screen.queryByAltText("待发送截图预览")).not.toBeInTheDocument());
  });

  it("sends a screenshot without any text", async () => {
    vi.mocked(URL.createObjectURL).mockReturnValue(IMAGE_DATA_URL);
    const bridge = renderIntake();

    const input = await screen.findByLabelText("输入消息");
    pasteImage(input, new File(["png"], "截图.png", { type: "image/png" }));
    expect(await screen.findByAltText("待发送截图预览")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(bridge.sendInterviewIntakeMessage).toHaveBeenCalledOnce());
    expect(bridge.sendInterviewIntakeMessage).toHaveBeenCalledWith("", [
      { name: "截图.png", dataUrl: IMAGE_DATA_URL },
    ]);
    await waitFor(() => expect(screen.queryByAltText("待发送截图预览")).not.toBeInTheDocument());
  });

  it("ignores pasted files that are not images", async () => {
    renderIntake();

    const input = await screen.findByLabelText("输入消息");
    pasteImage(input, new File(["text"], "notes.txt", { type: "text/plain" }));

    expect(screen.queryByAltText("待发送截图预览")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });
});
