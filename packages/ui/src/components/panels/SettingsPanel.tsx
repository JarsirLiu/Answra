import { PanelShell } from "./PanelShell";

interface SettingsPanelProps {
  /** 是否跟随屏幕背景自动变色（变色龙主题）。 */
  ambientFollow: boolean;
  localOnly: boolean;
  modeLabel: string;
  onAmbientFollowChange: (value: boolean) => void;
  onLocalOnlyChange: (value: boolean) => void;
  onClose: () => void;
}

/** 设置面板：当前为本地原型占位，AI 服务后续接入。 */
export function SettingsPanel({
  ambientFollow,
  localOnly,
  modeLabel,
  onAmbientFollowChange,
  onLocalOnlyChange,
  onClose,
}: SettingsPanelProps) {
  return (
    <PanelShell modeLabel={modeLabel} onClose={onClose} title="设置" variant="settings">
      <div className="settings-panel">
        <h2>外观</h2>
        <label className="setting-row">
          <span>
            <strong>跟随背景色</strong>
            <small>自动采样屏幕背景，调整悬浮条配色以减少视觉打扰</small>
          </span>
          <input
            checked={ambientFollow}
            onChange={(event) => onAmbientFollowChange(event.target.checked)}
            type="checkbox"
          />
        </label>
        <h2>本地运行</h2>
        <p>当前原型不连接云端服务。AI 服务将在后续本地 API 阶段配置。</p>
        <label className="setting-row">
          <span>
            <strong>仅使用本地服务</strong>
            <small>不启用云端订阅或远程 API</small>
          </span>
          <input
            checked={localOnly}
            onChange={(event) => onLocalOnlyChange(event.target.checked)}
            type="checkbox"
          />
        </label>
        <div className="setting-row setting-row--static">
          <span>
            <strong>AI 服务</strong>
            <small>尚未连接</small>
          </span>
          <span className="setting-status">未配置</span>
        </div>
      </div>
    </PanelShell>
  );
}
