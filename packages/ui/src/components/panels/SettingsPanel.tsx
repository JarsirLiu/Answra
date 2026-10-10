import { RangeSlider } from "../controls/RangeSlider";
import { Switch } from "../controls/Switch";
import { PanelShell } from "./PanelShell";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  /** 是否跟随屏幕背景自动变色（变色龙主题）；开启时深浅方案随背景亮度自动决定。 */
  ambientFollow: boolean;
  /** 前景透明度（0.5~1）；文字/图标/描边随之变化，表面恒不透明。 */
  opacity: number;
  localOnly: boolean;
  stealth: boolean;
  /** 系统是否可靠支持隐身（内容保护）；不支持时开关禁用。 */
  stealthSupported: boolean;
  onAmbientFollowChange: (value: boolean) => void;
  onOpacityChange: (value: number) => void;
  onLocalOnlyChange: (value: boolean) => void;
  onStealthChange: (value: boolean) => void;
  onClose: () => void;
}

const OPACITY_MIN = 0.5;
const OPACITY_MAX = 1;

/** 设置面板：常规/本地运行/模型分组；控件一律用统一令牌控件，不用原生样式。 */
export function SettingsPanel({
  ambientFollow,
  opacity,
  localOnly,
  stealth,
  stealthSupported,
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
            </span>
            <Switch
              ariaLabel="跟随背景色"
              checked={ambientFollow}
              onChange={onAmbientFollowChange}
            />
          </label>
          <div className="setting-row">
            <span>
              <strong>前景透明度</strong>
            </span>
            <span className="setting-control">
              <RangeSlider
                ariaLabel="前景透明度"
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
            </span>
            <Switch
              ariaLabel="会议隐身"
              checked={stealth}
              disabled={!stealthSupported}
              onChange={onStealthChange}
            />
          </label>
        </section>

        <section className="settings-group">
          <h2>本地运行</h2>
          <label className="setting-row">
            <span>
              <strong>仅使用本地服务</strong>
            </span>
            <Switch
              ariaLabel="仅使用本地服务"
              checked={localOnly}
              onChange={onLocalOnlyChange}
            />
          </label>
          <div className="setting-row setting-row--static">
            <span>
              <strong>AI 服务</strong>
            </span>
            <span className="setting-status">未配置</span>
          </div>
        </section>

        <section className="settings-group">
          <h2>模型</h2>
          <div className="setting-row setting-row--static">
            <span>
              <strong>默认模型</strong>
            </span>
            <span className="setting-status">未配置</span>
          </div>
        </section>
      </div>
    </PanelShell>
  );
}
