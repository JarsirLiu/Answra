import type { AgentConnectionState, DesktopBridge } from "@answra/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConnectionState } from "../src/app/useConnectionState";

function unavailableState(revision: number): AgentConnectionState {
  return {
    target: "agent-service",
    revision,
    updatedAt: 1_000,
    status: "unavailable",
    attempt: 5,
    maxAttempts: 5,
    reason: "worker-exit",
  };
}

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
  it("ignores startup retries until the first successful connection", async () => {
    let listener: ((value: AgentConnectionState) => void) | undefined;
    const bridge: Partial<DesktopBridge> = {
      getConnectionState: vi.fn(() => new Promise<AgentConnectionState>(() => undefined)),
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
      listener?.(unavailableState(3));
    });
    expect(result.current).toBeUndefined();

    await act(async () => {
      listener?.(state(4, "connected"));
    });
    expect(result.current).toMatchObject({ revision: 4, status: "connected" });

    await act(async () => {
      listener?.(state(5, "reconnecting"));
    });
    expect(result.current).toMatchObject({ revision: 5, status: "reconnecting" });
  });

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
      listener?.(state(2, "connected"));
    });
    expect(result.current).toMatchObject({ revision: 2, status: "connected" });

    await act(async () => {
      resolveSnapshot?.(state(1, "connected"));
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ revision: 2, status: "connected" });
  });

  it("keeps a pushed state when the initial snapshot request fails", async () => {
    const bridge: Partial<DesktopBridge> = {
      getConnectionState: vi.fn(async () => {
        throw new Error("IPC unavailable");
      }),
      onConnectionState: vi.fn((next: (value: AgentConnectionState) => void) => {
        next(state(2, "connected"));
        next(state(3, "reconnecting"));
        return () => undefined;
      }),
    };
    const { result } = renderHook(() => useConnectionState(bridge as DesktopBridge));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ revision: 3, status: "reconnecting" });
  });
});
