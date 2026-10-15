import type { DesktopBridge, ImeState } from "@answra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/components/panels/ChatPanel";

const enabledImeState: ImeState = {
  enabled: true,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

describe("ChatPanel", () => {
  it("shows the response caret only on the active assistant answer", () => {
    const props = {
      attachments: [],
      draft: "",
      fileInputRef: createRef<HTMLInputElement>(),
      messages: [
        { id: "old", role: "assistant" as const, content: "Earlier answer" },
        { id: "current", role: "assistant" as const, content: "Current answer" },
      ],
      onAttachmentChange: vi.fn(),
      onAttachmentRemove: vi.fn(),
      onCancel: vi.fn(),
      onClose: vi.fn(),
      onDraftChange: vi.fn(),
      onSend: vi.fn(),
      stealth: false,
      streaming: true,
    };
    const { container, rerender } = render(<ChatPanel {...props} />);

    expect(container.querySelectorAll("[data-caret]")).toHaveLength(1);
    expect(screen.getByText("Current answer").closest("[data-caret]")).toHaveAttribute(
      "data-caret",
      "true",
    );

    rerender(<ChatPanel {...props} streaming={false} />);
    expect(container.querySelector("[data-caret]")).toBeNull();
  });

  it("replaces the selected draft range with the Rime commit", async () => {
    const onDraftChange = vi.fn();
    const bridge = {
      imeAvailable: true,
      imeAcquire: vi.fn().mockResolvedValue({
        state: enabledImeState,
        targetId: "chat-composer",
        generation: 1,
        accepted: true,
      }),
      imeRelease: vi.fn().mockResolvedValue({ state: enabledImeState, accepted: true }),
      imeKey: vi.fn().mockResolvedValue({ ...enabledImeState, committedText: "新" }),
      imeSelect: vi.fn().mockResolvedValue(enabledImeState),
      onImeChange: vi.fn(() => () => undefined),
      onImeCandidateAction: vi.fn(() => () => undefined),
      setImeCandidate: vi.fn(),
    } as unknown as DesktopBridge;
    render(
      <ChatPanel
        attachments={[]}
        bridge={bridge}
        draft="abcd"
        fileInputRef={createRef<HTMLInputElement>()}
        messages={[]}
        onAttachmentChange={vi.fn()}
        onAttachmentRemove={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        onDraftChange={onDraftChange}
        onSend={vi.fn()}
        stealth={false}
        streaming={false}
      />,
    );
    const input = screen.getByRole("textbox", { name: "补充问题" }) as HTMLTextAreaElement;
    fireEvent.focus(input);
    await waitFor(() => expect(bridge.imeAcquire).toHaveBeenCalledWith("chat-composer"));
    input.setSelectionRange(1, 3);
    fireEvent.keyDown(input, { key: "n", code: "KeyN" });
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("a新d"));
  });
});
