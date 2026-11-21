import type {
  DesktopBridge,
  RemoteHostKeyCreation,
  RemoteHostState,
  RemoteHostStatus,
} from "@answra/shared";
import { useEffect, useState } from "react";
import { SurfaceButton } from "../controls/SurfaceButton";

const STATE_LABELS: Record<RemoteHostState, string> = {
  stopped: "未连接",
  starting: "正在连接",
  waiting: "等待控制器",
  ready: "已连接",
  reconnecting: "正在重连",
  interrupted: "连接中断",
};

interface RemoteHostSettingsProps {
  bridge?: DesktopBridge;
  signedIn: boolean;
}

export function RemoteHostSettings({ bridge, signedIn }: RemoteHostSettingsProps) {
  const [status, setStatus] = useState<RemoteHostStatus | null>(null);
  const [createdKey, setCreatedKey] = useState<RemoteHostKeyCreation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const getStatus = bridge?.getRemoteHostStatus;
  const connectHost = bridge?.connectRemoteHost;
  const disconnectHost = bridge?.disconnectRemoteHost;
  const onStatus = bridge?.onRemoteHostStatus;

  useEffect(() => {
    if (!getStatus) return;
    let cancelled = false;
    getStatus()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    const unsubscribe = onStatus?.(setStatus);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [getStatus, onStatus]);

  useEffect(() => {
    if (status?.running === false) setCreatedKey(null);
  }, [status?.running]);

  if (!getStatus || !connectHost || !disconnectHost) return null;

  const connect = connectHost;
  const disconnect = disconnectHost;
  const running = status?.running === true;
  const statusLabel = !signedIn
    ? "登录后可用"
    : status === null
      ? "读取中"
      : running
        ? STATE_LABELS[status.state]
        : "未连接";

  async function handleConnect() {
    setBusy(true);
    setError("");
    setCopied(false);
    setCreatedKey(null);
    try {
      const result = await connect();
      setStatus(result.status);
      setCreatedKey(result.key);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError("");
    try {
      setStatus(await disconnect());
      setCreatedKey(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopied(true);
    } catch {
      setError("无法复制连接码，请手动选择文本。");
    }
  }

  return (
    <section className="settings-group">
      <h2>远程控制</h2>
      <div className="setting-model-footer">
        <span className="setting-status">{statusLabel}</span>
        <SurfaceButton
          className="setting-action"
          disabled={busy || !signedIn}
          onClick={() => void (running ? handleDisconnect() : handleConnect())}
          size="sm"
          variant={running ? "quiet" : "primary"}
        >
          {busy ? "处理中…" : running ? "断开连接" : "远程连接"}
        </SurfaceButton>
      </div>
      {createdKey && (
        <div className="setting-key">
          <code>{createdKey.key}</code>
          <SurfaceButton
            className="setting-action"
            disabled={busy}
            onClick={() => void copyKey()}
            size="xs"
            variant="quiet"
          >
            {copied ? "已复制" : "复制"}
          </SurfaceButton>
        </div>
      )}
      {status?.lastError && (
        <p className="setting-error" role="alert">
          {status.lastError}
        </p>
      )}
      {error && (
        <p className="setting-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "远程控制操作失败";
}
