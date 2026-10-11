import type { ConversationModelConfig } from "@answra/shared";
import { useState } from "react";
import { RangeSlider } from "../controls/RangeSlider";
import { Switch } from "../controls/Switch";
import { PanelShell } from "./PanelShell";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  /** 是否跟随屏幕背景自动变色（变色龙主题）；开启时深浅方案随背景亮度自动决定。 */
  ambientFollow: boolean;
  /** 前景透明度（0.5~1）；文字/图标/描边随之变化，表面恒不透明。 */
  opacity: number;
  stealth: boolean;
  /** 系统是否可靠支持隐身（内容保护）；不支持时开关禁用。 */
  stealthSupported: boolean;
  onAmbientFollowChange: (value: boolean) => void;
  onOpacityChange: (value: number) => void;
  onStealthChange: (value: boolean) => void;
  onClose: () => void;
  modelConfig: { baseUrl: string; model: string; configured: boolean };
  onModelConfigSave: (config: ConversationModelConfig) => Promise<void>;
}

const OPACITY_MIN = 0.5;
const OPACITY_MAX = 1;

/** 设置面板：常规/模型两组；控件一律用统一令牌控件，不用原生样式。 */
export function SettingsPanel({
  ambientFollow,
  opacity,
  stealth,
  stealthSupported,
  onAmbientFollowChange,
  onOpacityChange,
  onStealthChange,
  onClose,
  modelConfig,
  onModelConfigSave,
}: SettingsPanelProps) {
  const [baseUrl, setBaseUrl] = useState(modelConfig.baseUrl);
  const [model, setModel] = useState(modelConfig.model);
  const [apiKey, setApiKey] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveModelConfig() {
    setSaving(true);
    setSaveError("");
    try {
      await onModelConfigSave({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      setApiKey("");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存模型配置失败");
    } finally {
      setSaving(false);
    }
  }
  return (
    <PanelShell onClose={onClose} title="设置" variant="settings">
      <div className="settings-panel">
        <section className="settings-group">
          <h2>常规</h2>
          <div className="setting-row">
            <span>
              <strong>跟随背景色</strong>
            </span>
            <Switch
              ariaLabel="跟随背景色"
              checked={ambientFollow}
              onChange={onAmbientFollowChange}
            />
          </div>
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
          <div className="setting-row">
            <span>
              <strong>会议隐身</strong>
            </span>
            <Switch
              ariaLabel="会议隐身"
              checked={stealth}
              disabled={!stealthSupported && !stealth}
              onChange={onStealthChange}
            />
          </div>
        </section>

        <section className="settings-group">
          <h2>模型</h2>
          <label className="setting-field">
            <span>OpenAI-compatible 地址</span>
            <input
              autoComplete="url"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:1234/v1"
              value={baseUrl}
            />
          </label>
          <label className="setting-field">
            <span>模型名称</span>
            <input
              onChange={(event) => setModel(event.target.value)}
              placeholder="模型 ID"
              value={model}
            />
          </label>
          <label className="setting-field">
            <span>API Key（可选）</span>
            <input
              autoComplete="new-password"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="留空保留已保存的 Key"
              type="password"
              value={apiKey}
            />
          </label>
          <div className="setting-model-footer">
            <span className="setting-status">{modelConfig.configured ? "已配置" : "尚未配置"}</span>
            <button
              disabled={saving || !baseUrl.trim() || !model.trim()}
              onClick={() => void saveModelConfig()}
              type="button"
            >
              {saving ? "保存中" : "保存"}
            </button>
          </div>
          {saveError && (
            <p className="setting-error" role="alert">
              {saveError}
            </p>
          )}
        </section>
      </div>
    </PanelShell>
  );
}
