import { RangeSlider } from "../controls/RangeSlider";
import { PanelShell } from "./PanelShell";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  /** 是否跟随屏幕背景自动变色（变色龙主题）。 */
  ambientFollow: boolean;
  /** 整体透明度（0.5~1）；背景、字体、图标一同变化。 */
  opacity: number;
  localOnly: boolean;
  stealth: boolean;
  onAmbientFollowChange: (value: boolean) => void;
  onOpacityChange: (value: number) => void;
  onLocalOnlyChange: (value: boolean) => void;
  onStealthChange: (value: boolean) => void;
  onClose: () => void;
}

const OPACITY_MIN = 0.5;
const OPACITY_MAX = 1;

/** 设置面板：常规/本地运行/模型分组，透明度影响整个应用外观。 */
export function SettingsPanel({
  ambientFollow,
  opacity,
  localOnly,
  stealth,
  onAmbientFollowChange,
  onOpacityChange,
  onLocalOnlyChange,
  onStealthChange,
  onClose,
}: SettingsPanelProps) {
  return (
    <PanelShell onClose={onClose} title="设置" variant="settings">
      <div className="settings-panel">
        <section className="settings-group">
          <h2>常规</h2>
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
          <div className="setting-row">
            <span>
              <strong>整体透明度</strong>
              <small>背景、字体、图标随之一同变化；越低越不抢眼</small>
            </span>
            <span className="setting-control">
              <RangeSlider
                ariaLabel="整体透明度"
                max={OPACITY_MAX}
                min={OPACITY_MIN}
                onChange={onOpacityChange}
                step={0.05}
                value={opacity}
              />
              <span className="setting-value">{Math.round(opacity * 100)}%</span>
            </span>
          </div>
          <label className="setting-row">
            <span>
              <strong>会议隐身</strong>
              <small>开启后屏幕共享与截图捕获不到本应用，你自己仍可见</small>
            </span>
            <input
              checked={stealth}
              onChange={(event) => onStealthChange(event.target.checked)}
              type="checkbox"
            />
          </label>
        </section>

        <section className="settings-group">
          <h2>本地运行</h2>
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
        </section>

        <section className="settings-group">
          <h2>模型</h2>
          <label className="setting-row">
            <span>
              <strong>默认模型</strong>
              <small>接入本地 AI 服务后在此切换</small>
            </span>
            <span className="setting-control">
              <select className="setting-select" disabled defaultValue="">
                <option value="" disabled>
                  未配置
                </option>
              </select>
            </span>
          </label>
        </section>
      </div>
    </PanelShell>
  );
}
