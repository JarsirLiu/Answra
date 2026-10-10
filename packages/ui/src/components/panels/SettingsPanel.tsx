import { PanelShell } from "./PanelShell";

interface SettingsPanelProps {
  localOnly: boolean;
  modeLabel: string;
  onLocalOnlyChange: (value: boolean) => void;
  onClose: () => void;
}

/** 设置面板：当前为本地原型占位，AI 服务后续接入。 */
export function SettingsPanel({
  localOnly,
  modeLabel,
  onLocalOnlyChange,
  onClose,
}: SettingsPanelProps) {
  return (
    <PanelShell modeLabel={modeLabel} onClose={onClose} title="设置">
      <div className="settings-panel">
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
