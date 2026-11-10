import type { AgentConnectionState, DesktopBridge } from "@answra/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConnectionState } from "../src/app/useConnectionState";

function state(revision: number, status: "connected" | "reconnecting"): AgentConnectionState {
  return status === "connected"
    ? {
        target: "agent-service",
        revision,
        updatedAt: 1_000,
        status,
        attempt: 1,
        maxAttempts: 5,
        connectedAt: 1_000,
      }
    : {
        target: "agent-service",
        revision,
        updatedAt: 1_000,
        status,
        attempt: 2,
        maxAttempts: 5,
        nextRetryAt: 2_000,
        reason: "worker-exit",
      };
}

describe("useConnectionState", () => {
  it("keeps the newest revision when the initial snapshot resolves after a push", async () => {
    let resolveSnapshot: ((value: AgentConnectionState) => void) | undefined;
    let listener: ((value: AgentConnectionState) => void) | undefined;
    const bridge: Partial<DesktopBridge> = {
      getConnectionState: vi.fn(
        () =>
          new Promise<AgentConnectionState>((resolve) => {
            resolveSnapshot = resolve;
          }),
      ),
      onConnectionState: vi.fn((next: (value: AgentConnectionState) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
    };
    const { result } = renderHook(() => useConnectionState(bridge as DesktopBridge));

    await act(async () => {
      listener?.(state(2, "reconnecting"));
    });
    expect(result.current).toMatchObject({ revision: 2, status: "reconnecting" });

    await act(async () => {
      resolveSnapshot?.(state(1, "connected"));
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ revision: 2, status: "reconnecting" });
  });

  it("keeps a pushed state when the initial snapshot request fails", async () => {
    const bridge: Partial<DesktopBridge> = {
      getConnectionState: vi.fn(async () => {
        throw new Error("IPC unavailable");
      }),
      onConnectionState: vi.fn((next: (value: AgentConnectionState) => void) => {
        next(state(2, "reconnecting"));
        return () => undefined;
      }),
    };
    const { result } = renderHook(() => useConnectionState(bridge as DesktopBridge));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ revision: 2, status: "reconnecting" });
  });
});
