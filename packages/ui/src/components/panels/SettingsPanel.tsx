import type { ConversationModelConfig } from "@answra/shared";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RangeSlider } from "../controls/RangeSlider";
import { SurfaceButton } from "../controls/SurfaceButton";
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
  /** 按需拉取已保存的 API Key（显隐回显）；未实现或无 Key 时返回 null。 */
  onRevealApiKey?: () => Promise<{ apiKey: string | null }>;
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
  onRevealApiKey,
}: SettingsPanelProps) {
  const [baseUrl, setBaseUrl] = useState(modelConfig.baseUrl);
  const [model, setModel] = useState(modelConfig.model);
  const [apiKey, setApiKey] = useState("");
  // 打开面板即回显已保存的 Key，默认掩码（password 圆点）+ 闭眼图标；
  // 点眼睛切换明文，不再要求"点开才拉取"。
  const [showApiKey, setShowApiKey] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    return () => clearTimeout(savedTimerRef.current ?? undefined);
  }, []);

  const revealRef = useRef(onRevealApiKey);
  revealRef.current = onRevealApiKey;

  useEffect(() => {
    // 打开面板即拉取已保存的 Key 回显（掩码展示）；未配置或未实现时保持空。
    // 通过 ref 取回调：上游每次渲染传新箭头函数，依赖它会造成重复拉取。
    const fetchKey = revealRef.current;
    if (!fetchKey) return;
    let cancelled = false;
    fetchKey()
      .then(({ apiKey: savedKey }) => {
        if (!cancelled && savedKey) setApiKey(savedKey);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveModelConfig() {
    setSaving(true);
    setSaveError("");
    setJustSaved(false);
    try {
      await onModelConfigSave({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      // Key 现在默认掩码回显，保存成功后保留输入内容不再清空；
      // 用"已保存"状态提示确认结果。
      setJustSaved(true);
      clearTimeout(savedTimerRef.current ?? undefined);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 2500);
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
            <span>API Key</span>
            <span className="setting-secret-field">
              <input
                autoComplete="new-password"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="必填"
                type={showApiKey ? "text" : "password"}
                value={apiKey}
              />
              <SurfaceButton
                aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                className="setting-secret-toggle"
                onClick={() => setShowApiKey((visible) => !visible)}
                title={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                variant="quiet"
              >
                {/* 掩码态 = 闭眼，明文态 = 睁眼，与直觉一致。 */}
                {showApiKey ? <Eye size={16} /> : <EyeOff size={16} />}
              </SurfaceButton>
            </span>
          </label>
          <div className="setting-model-footer">
            <span
              className={justSaved ? "setting-status setting-status--saved" : "setting-status"}
              role="status"
            >
              {justSaved ? "已保存" : modelConfig.configured ? "已配置" : "尚未配置"}
            </span>
            <SurfaceButton
              disabled={saving || !baseUrl.trim() || !model.trim()}
              onClick={() => void saveModelConfig()}
              variant="primary"
            >
              {saving ? "保存中" : "保存"}
            </SurfaceButton>
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
