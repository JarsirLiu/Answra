import type { DesktopBridge, SurfaceSpec, SurfaceWindowState } from "@answra/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceWindowApp } from "../src/surfaces/SurfaceWindowApp";

const spec: SurfaceSpec = {
  schemaVersion: 1,
  id: "test-surface",
  revision: 1,
  producer: "product",
  title: "确认操作",
  root: {
    type: "stack",
    direction: "column",
    gap: 8,
    children: [
      { type: "text", text: "这条说明来自声明式浮窗。" },
      {
        type: "stack",
        direction: "row",
        children: [
          { type: "button", label: "取消", actionId: "cancel", variant: "secondary" },
          { type: "button", label: "确认", actionId: "confirm", variant: "primary" },
        ],
      },
    ],
  },
  window: { dismissible: true },
  actions: {
    cancel: { type: "dismiss" },
    confirm: { type: "invoke", command: "test.confirm" },
  },
};

function createBridge() {
  let stateListener: ((state: SurfaceWindowState) => void) | undefined;
  return {
    bridge: {
      close: vi.fn(),
      fitContent: vi.fn(),
      fitSurface: vi.fn(),
      dismissSurface: vi.fn(),
      sendSurfaceAction: vi.fn(),
      requestSurfaceState: vi.fn(),
      onSurfaceState: vi.fn((listener: (state: SurfaceWindowState) => void) => {
        stateListener = listener;
        return () => {
          stateListener = undefined;
        };
      }),
    } satisfies Partial<DesktopBridge>,
    emit: (state: SurfaceWindowState) => {
      act(() => stateListener?.(state));
    },
  };
}

describe("surface window", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.stealth;
  });

  it("renders trusted primitives and forwards actions only by id", () => {
    const { bridge, emit } = createBridge();
    render(<SurfaceWindowApp bridge={bridge as DesktopBridge} />);
    expect(bridge.requestSurfaceState).toHaveBeenCalledOnce();

    emit({ spec, stealth: false });

    expect(screen.getByRole("dialog", { name: "确认操作" })).toBeInTheDocument();
    expect(screen.getByText("这条说明来自声明式浮窗。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(bridge.sendSurfaceAction).toHaveBeenCalledWith("confirm");

    fireEvent.click(screen.getByRole("button", { name: "关闭浮窗" }));
    expect(bridge.dismissSurface).toHaveBeenCalledOnce();
  });

  it("ignores an invalid spec and mirrors stealth onto the document", () => {
    const { bridge, emit } = createBridge();
    render(<SurfaceWindowApp bridge={bridge as DesktopBridge} />);

    emit({
      spec: { ...spec, root: { type: "html" } } as unknown as SurfaceSpec,
      stealth: true,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    emit({ spec, stealth: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.documentElement.dataset.stealth).toBe("true");
  });

  it("dismisses on Escape when the surface is dismissible", () => {
    const { bridge, emit } = createBridge();
    render(<SurfaceWindowApp bridge={bridge as DesktopBridge} />);
    emit({ spec, stealth: false });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(bridge.dismissSurface).toHaveBeenCalledOnce();
  });
});
