import type {
  DesktopBridge,
  ImeSessionCommand,
  ImeSessionSnapshot,
  ImeState,
} from "@answra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/components/panels/ChatPanel";

const enabledImeState: ImeState = {
  enabled: true,
  inputMode: "chinese",
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
    const legacyBridge = {
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
    const bridge = { ...legacyBridge } as DesktopBridge;
    let state: ImeState = enabledImeState;
    let owner: ImeSessionSnapshot["owner"];
    let revision = 0;
    const snapshot = (): ImeSessionSnapshot => ({
      phase: owner ? "owned" : "idle",
      ...(owner ? { owner } : {}),
      engine: state,
      revision,
    });
    bridge.imeSessionCommand = vi.fn(async (command: ImeSessionCommand) => {
      let response: unknown;
      if (command.type === "acquireTarget") {
        response = await legacyBridge.imeAcquire?.(command.targetId);
        const lease = response as {
          accepted: boolean;
          generation: number;
          targetId: string;
          state: ImeState;
        };
        state = lease.state;
        owner = {
          windowId: 1,
          webContentsId: 1,
          targetId: lease.targetId,
          generation: lease.generation,
        };
      } else if (command.type === "processKey") {
        response = await legacyBridge.imeKey?.(command);
      }
      const result = response as (ImeState & { accepted?: boolean; state?: ImeState }) | undefined;
      if (result && "state" in result && result.state) state = result.state;
      else if (result && "enabled" in result) state = result;
      revision += 1;
      return {
        commandId: command.commandId,
        accepted: result && "accepted" in result ? result.accepted === true : state.enabled,
        snapshot: snapshot(),
        ...(state.committedText ? { commit: { text: state.committedText, revision } } : {}),
      };
    });
    bridge.getImeSessionSnapshot = async () => snapshot();
    bridge.onImeSessionSnapshot = () => () => undefined;
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
    await waitFor(() =>
      expect(bridge.imeSessionCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: "acquireTarget", targetId: "chat-composer" }),
      ),
    );
    input.setSelectionRange(1, 3);
    fireEvent.keyDown(input, { key: "n", code: "KeyN" });
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("a新d"));
  });
});
