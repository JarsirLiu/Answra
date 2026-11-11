/**
 * 设置页「关于」分组：展示版本号，并提供检查、点击下载与立即重启安装。
 *
 * 更新状态由 main 进程推送，这里只做镜像；不在渲染层根据版本号推算状态。
 */

import type { DesktopBridge, UpdateStatus } from "@answra/shared";
import { useEffect, useState } from "react";
import { SurfaceButton } from "../controls/SurfaceButton";
import "./UpdateSettingsGroup.css";

type UpdateAction = "check" | "download" | "install";

interface UpdateSettingsGroupProps {
  bridge?: DesktopBridge;
}

export function UpdateSettingsGroup({ bridge }: UpdateSettingsGroupProps) {
  const getUpdateStatus = bridge?.getUpdateStatus;
  const onUpdateStatus = bridge?.onUpdateStatus;
  const checkForUpdates = bridge?.checkForUpdates;
  const downloadUpdate = bridge?.downloadUpdate;
  const installUpdateNow = bridge?.installUpdateNow;

  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (!getUpdateStatus) return;
    let cancelled = false;
    void getUpdateStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setActionError("无法读取版本信息");
      });
    const unsubscribe = onUpdateStatus?.((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next.phase !== "downloaded") setConfirming(false);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [getUpdateStatus, onUpdateStatus]);

  if (!getUpdateStatus) return null;

  const percent = Math.round(clampPercent(status?.progress?.percent ?? 0));
  const action = actionFor(status, confirming);

  async function runUpdate(
    call: () => Promise<UpdateStatus>,
    failureMessage: string,
  ): Promise<void> {
    setBusy(true);
    setActionError("");
    try {
      setStatus(await call());
    } catch {
      setActionError(failureMessage);
    } finally {
      setBusy(false);
    }
  }

  async function installNow(): Promise<void> {
    if (!installUpdateNow) return;
    setBusy(true);
    setActionError("");
    try {
      const result = await installUpdateNow();
      if (!result.started) {
        setConfirming(false);
        setActionError("无法启动安装程序，请稍后重试");
      }
    } catch {
      setConfirming(false);
      setActionError("无法启动安装程序，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function handleAction(kind: UpdateAction): void {
    if (kind === "check" && checkForUpdates) {
      void runUpdate(() => checkForUpdates(), "无法发起更新检查");
      return;
    }
    if (kind === "download" && downloadUpdate) {
      void runUpdate(() => downloadUpdate(), "无法开始下载更新");
      return;
    }
    if (kind === "install") {
      if (!confirming) {
        setActionError("");
        setConfirming(true);
        return;
      }
      void installNow();
    }
  }

  const detail = detailFor(status, confirming, percent);

  return (
    <section className="settings-group">
      <h2>关于</h2>
      <div className="setting-row">
        <span>
          <strong>版本</strong>
        </span>
        <span className="setting-value">{status ? `v${status.currentVersion}` : "—"}</span>
      </div>
      <div className="setting-row">
        <span className="update-summary">
          <strong>{titleFor(status)}</strong>
          {detail && (
            <span
              className={
                status?.phase === "error" ? "update-detail setting-error" : "update-detail"
              }
              role={status?.phase === "error" ? "alert" : undefined}
            >
              {detail}
            </span>
          )}
        </span>
        {action && (
          <span className="update-actions">
            <SurfaceButton
              className="setting-action"
              disabled={busy || !action.enabled}
              onClick={() => handleAction(action.kind)}
              size="sm"
              variant={action.kind === "install" ? "primary" : "default"}
            >
              {action.label}
            </SurfaceButton>
          </span>
        )}
      </div>
      {status?.phase === "downloading" && (
        <div
          aria-label="更新下载进度"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="update-progress"
          role="progressbar"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {actionError && (
        <p className="setting-error" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}

function titleFor(status: UpdateStatus | null): string {
  if (!status) return "版本与更新";
  switch (status.phase) {
    case "unsupported":
      return "更新不可用";
    case "checking":
      return "正在检查更新";
    case "up-to-date":
      return "已是最新版本";
    case "available":
      return `发现 v${status.availableVersion ?? "新版本"}`;
    case "downloading":
      return `正在下载 v${status.availableVersion ?? "新版本"}`;
    case "downloaded":
      return `已下载 v${status.availableVersion ?? "新版本"}`;
    case "error":
      return "更新失败";
    case "idle":
      return "版本与更新";
  }
}

function detailFor(
  status: UpdateStatus | null,
  confirming: boolean,
  percent: number,
): string | null {
  if (!status) return "正在读取版本信息…";
  switch (status.phase) {
    case "unsupported":
      return "开发模式或当前平台不支持自动更新";
    case "checking":
      return "正在向更新服务器查询…";
    case "available":
      // autoDownload 关闭：发现新版本后停在 available，等用户点击下载。
      return "有新版本可下载";
    case "downloading":
      return status.progress ? `已下载 ${percent}%` : "正在下载更新包…";
    case "downloaded":
      if (confirming) return "将关闭应用并立即安装，未保存的草稿会丢失。";
      return installModeDetail(status.installMode);
    case "error":
      return status.error;
    case "idle":
    case "up-to-date":
      return null;
  }
}

function actionFor(
  status: UpdateStatus | null,
  confirming: boolean,
): { kind: UpdateAction; label: string; enabled: boolean } | null {
  if (!status) return null;
  switch (status.phase) {
    case "unsupported":
      return null;
    case "checking":
      return { kind: "check", label: "正在检查…", enabled: false };
    case "available":
      return { kind: "download", label: "下载更新", enabled: true };
    case "downloading":
      return { kind: "download", label: "下载中…", enabled: false };
    case "downloaded":
      return {
        kind: "install",
        label: confirming ? "确认重启并安装" : "立即重启安装",
        enabled: true,
      };
    case "error":
      return status.availableVersion
        ? { kind: "download", label: "重试下载", enabled: true }
        : { kind: "check", label: "重试", enabled: true };
    case "idle":
    case "up-to-date":
      return { kind: "check", label: "检查更新", enabled: true };
  }
}

function installModeDetail(mode: UpdateStatus["installMode"]): string {
  switch (mode) {
    case "next-launch":
      return "下次启动应用时自动安装";
    case "auto-swap":
      return "将自动换装并重启";
    case "on-quit":
      return "退出应用后自动安装";
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
