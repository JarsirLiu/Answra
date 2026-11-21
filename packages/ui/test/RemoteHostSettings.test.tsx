import type { DesktopBridge, RemoteHostStatus } from "@answra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoteHostSettings } from "../src/components/panels/RemoteHostSettings";

const KEY = {
  keyId: "0123456789abcdef",
  createdAt: "2026-11-21T00:00:00.000Z",
};

function status(overrides: Partial<RemoteHostStatus> = {}): RemoteHostStatus {
  return {
    running: false,
    state: "stopped",
    key: KEY,
    statusLine: null,
    lastError: null,
    ...overrides,
  };
}

function createBridge(initial: RemoteHostStatus): DesktopBridge & {
  connectRemoteHost: ReturnType<typeof vi.fn>;
  disconnectRemoteHost: ReturnType<typeof vi.fn>;
} {
  return {
    fitContent: vi.fn(),
    close: vi.fn(),
    getRemoteHostStatus: vi.fn(async () => initial),
    connectRemoteHost: vi.fn(async () => ({
      key: {
        key: "answra1.room.key.secret",
        keyId: KEY.keyId,
      },
      status: status({ running: true, state: "waiting" }),
    })),
    disconnectRemoteHost: vi.fn(async () => status()),
    onRemoteHostStatus: vi.fn(() => () => undefined),
  };
}

describe("RemoteHostSettings", () => {
  it("disables remote connection until signed in", async () => {
    const bridge = createBridge(status({ key: null }));

    render(<RemoteHostSettings bridge={bridge} signedIn={false} />);

    expect(await screen.findByText("登录后可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "远程连接" })).toBeDisabled();
  });

  it("connects through one bridge command and exposes the plaintext once", async () => {
    const bridge = createBridge(status({ key: null }));

    render(<RemoteHostSettings bridge={bridge} signedIn />);
    fireEvent.click(await screen.findByRole("button", { name: "远程连接" }));

    expect(await screen.findByText("answra1.room.key.secret")).toBeInTheDocument();
    expect(bridge.connectRemoteHost).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "断开连接" })).toBeInTheDocument();
  });

  it("disconnects through the bridge and clears the connection code", async () => {
    const bridge = createBridge(status());

    render(<RemoteHostSettings bridge={bridge} signedIn />);
    fireEvent.click(await screen.findByRole("button", { name: "远程连接" }));
    expect(await screen.findByText("answra1.room.key.secret")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "断开连接" }));

    await waitFor(() => expect(bridge.disconnectRemoteHost).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "远程连接" })).toBeInTheDocument();
    expect(screen.queryByText("answra1.room.key.secret")).not.toBeInTheDocument();
  });
});
