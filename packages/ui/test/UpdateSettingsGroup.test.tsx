import type { DesktopBridge, UpdateStatus } from "@answra/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateSettingsGroup } from "../src/components/panels/UpdateSettingsGroup";

function updateStatus(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    progress: null,
    error: null,
    installMode: "next-launch",
    downloadedPath: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

function updateBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    fitContent: vi.fn(),
    close: vi.fn(),
    getUpdateStatus: vi.fn().mockResolvedValue(updateStatus()),
    onUpdateStatus: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn().mockResolvedValue(updateStatus({ phase: "checking" })),
    downloadUpdate: vi.fn().mockResolvedValue(updateStatus({ phase: "downloading" })),
    installUpdateNow: vi.fn().mockResolvedValue({ started: true }),
    ...overrides,
  };
}

/** 「关于」分组：状态镜像、手动检查/重试、立即安装与订阅清理。 */
describe("UpdateSettingsGroup", () => {
  it("shows the current version and checks on demand", async () => {
    const checkForUpdates = vi.fn().mockResolvedValue(updateStatus({ phase: "checking" }));
    render(<UpdateSettingsGroup bridge={updateBridge({ checkForUpdates })} />);

    expect(await screen.findByText("v0.1.0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledOnce());
    expect(await screen.findByText("正在检查更新")).toBeInTheDocument();
  });

  it("renders download progress and disables the action while downloading", async () => {
    render(
      <UpdateSettingsGroup
        bridge={updateBridge({
          getUpdateStatus: vi.fn().mockResolvedValue(
            updateStatus({
              phase: "downloading",
              availableVersion: "0.2.0",
              progress: { percent: 42.4, transferred: 42, total: 100 },
            }),
          ),
        })}
      />,
    );

    expect(await screen.findByText("正在下载 v0.2.0")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "更新下载进度" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(screen.getByRole("button", { name: "下载中…" })).toBeDisabled();
  });

  it("asks for confirmation before restarting to install", async () => {
    const installUpdateNow = vi.fn().mockResolvedValue({ started: true });
    render(
      <UpdateSettingsGroup
        bridge={updateBridge({
          getUpdateStatus: vi.fn().mockResolvedValue(
            updateStatus({
              phase: "downloaded",
              availableVersion: "0.2.0",
              lastCheckedAt: "2026-11-01T08:00:00.000Z",
            }),
          ),
          installUpdateNow,
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "立即重启安装" }));
    expect(installUpdateNow).not.toHaveBeenCalled();
    expect(screen.getByText("将关闭应用并立即安装，未保存的草稿会丢失。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认重启并安装" }));
    await waitFor(() => expect(installUpdateNow).toHaveBeenCalledOnce());
  });

  it("retries a failed download and surfaces the failure reason", async () => {
    const downloadUpdate = vi
      .fn()
      .mockResolvedValue(updateStatus({ phase: "downloading", availableVersion: "0.2.0" }));
    render(
      <UpdateSettingsGroup
        bridge={updateBridge({
          getUpdateStatus: vi.fn().mockResolvedValue(
            updateStatus({
              phase: "error",
              availableVersion: "0.2.0",
              error: "更新下载失败，请重试",
            }),
          ),
          downloadUpdate,
        })}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("更新下载失败，请重试");
    fireEvent.click(screen.getByRole("button", { name: "重试下载" }));

    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledOnce());
    expect(await screen.findByText("正在下载 v0.2.0")).toBeInTheDocument();
  });

  it("reports unsupported environments without offering an action", async () => {
    render(
      <UpdateSettingsGroup
        bridge={updateBridge({
          getUpdateStatus: vi.fn().mockResolvedValue(updateStatus({ phase: "unsupported" })),
        })}
      />,
    );

    expect(await screen.findByText("更新不可用")).toBeInTheDocument();
    expect(screen.getByText("开发模式或当前平台不支持自动更新")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
  });

  it("waits in available until the user clicks the download button", async () => {
    const downloadUpdate = vi
      .fn()
      .mockResolvedValue(updateStatus({ phase: "downloading", availableVersion: "0.2.0" }));
    render(
      <UpdateSettingsGroup
        bridge={updateBridge({
          getUpdateStatus: vi
            .fn()
            .mockResolvedValue(updateStatus({ phase: "available", availableVersion: "0.2.0" })),
          downloadUpdate,
        })}
      />,
    );

    expect(await screen.findByText("发现 v0.2.0")).toBeInTheDocument();
    expect(screen.getByText("有新版本可下载")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下载更新" }));
    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledOnce());
    expect(await screen.findByText("正在下载 v0.2.0")).toBeInTheDocument();
  });

  it("installing a downloaded update asks for confirmation on both platforms", async () => {
    const installUpdateNow = vi.fn().mockResolvedValue({ started: true });
    render(
      <UpdateSettingsGroup
        bridge={updateBridge({
          getUpdateStatus: vi.fn().mockResolvedValue(
            updateStatus({
              phase: "downloaded",
              availableVersion: "0.2.0",
              installMode: "auto-swap",
              downloadedPath: "/Users/me/Library/Application Support/Answra/mac-update/Answra.app",
              lastCheckedAt: "2026-11-01T08:00:00.000Z",
            }),
          ),
          installUpdateNow,
        })}
      />,
    );

    expect(await screen.findByText("将自动换装并重启")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即重启安装" }));
    expect(installUpdateNow).not.toHaveBeenCalled();
    expect(screen.getByText("将关闭应用并立即安装，未保存的草稿会丢失。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认重启并安装" }));
    await waitFor(() => expect(installUpdateNow).toHaveBeenCalledOnce());
  });

  it("mirrors pushed status changes and unsubscribes on unmount", async () => {
    let emit: (status: UpdateStatus) => void = () => undefined;
    const unsubscribe = vi.fn();
    const onUpdateStatus = vi.fn((listener: (status: UpdateStatus) => void) => {
      emit = listener;
      return unsubscribe;
    });

    const view = render(<UpdateSettingsGroup bridge={updateBridge({ onUpdateStatus })} />);
    expect(await screen.findByText("v0.1.0")).toBeInTheDocument();

    act(() =>
      emit(
        updateStatus({
          phase: "downloading",
          availableVersion: "0.2.0",
          progress: { percent: 10, transferred: 1, total: 10 },
        }),
      ),
    );
    expect(screen.getByRole("progressbar", { name: "更新下载进度" })).toHaveAttribute(
      "aria-valuenow",
      "10",
    );

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("renders nothing when the bridge does not support updates", () => {
    const view = render(<UpdateSettingsGroup bridge={{ fitContent: vi.fn(), close: vi.fn() }} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
