/**
 * 设置 →「语音合成」的 provider 表单：供应商下拉（含品牌图标）、协议（仅自定义）、
 * 端点（仅自定义可改）/模型/音色与 Key。
 *
 * 表单只持有本地交互；保存与读取已存 Key 由父级经 DesktopBridge 完成，
 * Key 明文只在用户点「显示」后回填到掩码输入框，本组件不缓存、不写日志。
 */
import {
  findTtsProviderPreset,
  TTS_PROTOCOLS,
  TTS_PROVIDER_CATALOG,
  type TtsProviderConfig,
} from "@answra/shared";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TTS_PROTOCOL_LABELS } from "../../tts/labels";
import {
  applyPreset,
  CUSTOM_PRESET_VALUE,
  selectCustom,
  selectProtocol,
  type TtsProviderFormState,
} from "../../tts/providerDraft";
import { TtsVendorIcon } from "../../tts/providerIcons";
import { IconButton } from "../controls/IconButton";
import { SurfaceButton } from "../controls/SurfaceButton";
import { Tooltip } from "../controls/Tooltip";

interface TtsProviderFormProps {
  form: TtsProviderFormState;
  /** 当前已保存的 provider；决定 Key 是否已保存与是否显示「清除」。 */
  provider: TtsProviderConfig | null;
  busy: boolean;
  revealed: boolean;
  notice: string;
  onChange: (next: TtsProviderFormState) => void;
  onSave: () => void;
  onClear: () => void;
  onRevealKey: () => void;
  /** 打开厂商的 API Key 页面；宿主未提供时隐藏入口。 */
  onOpenApiKey?: (url: string) => void;
}

export function TtsProviderForm({
  form,
  provider,
  busy,
  revealed,
  notice,
  onChange,
  onSave,
  onClear,
  onRevealKey,
  onOpenApiKey,
}: TtsProviderFormProps) {
  const preset = form.presetId === null ? undefined : findTtsProviderPreset(form.presetId);
  const [menuOpen, setMenuOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // 菜单是表单内的轻量浮层：点外部或按 Esc 收回，不引入全局浮层协调器。
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  function update(patch: Partial<TtsProviderFormState>): void {
    onChange({ ...form, ...patch });
  }

  /** 选厂商 = 明确套用预设（覆盖字段、清空 Key）；选「自定义」才保留手填。 */
  function selectVendor(value: string): void {
    setMenuOpen(false);
    if (value === CUSTOM_PRESET_VALUE) {
      onChange(selectCustom(form));
      return;
    }
    const selected = findTtsProviderPreset(value);
    if (selected === undefined) return;
    onChange(applyPreset(selected, form));
  }

  const vendorLabel = preset?.label ?? "自定义";

  return (
    <div className="setting-tts-form">
      <div className="setting-field">
        <span>供应商</span>
        <div className="setting-tts-vendor" ref={pickerRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="listbox"
            aria-label="供应商"
            className="setting-tts-vendor-trigger"
            disabled={busy}
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            <TtsVendorIcon presetId={form.presetId} />
            <span>{vendorLabel}</span>
            <ChevronDown aria-hidden="true" className="setting-tts-vendor-chevron" size={14} />
          </button>
          {menuOpen && (
            <div aria-label="供应商" className="setting-tts-vendor-menu" role="listbox">
              {TTS_PROVIDER_CATALOG.map((item) => (
                <button
                  aria-selected={form.presetId === item.id}
                  className="setting-tts-vendor-option"
                  key={item.id}
                  onClick={() => selectVendor(item.id)}
                  role="option"
                  type="button"
                >
                  <TtsVendorIcon presetId={item.id} />
                  <span>{item.label}</span>
                </button>
              ))}
              <button
                aria-selected={form.presetId === null}
                className="setting-tts-vendor-option"
                onClick={() => selectVendor(CUSTOM_PRESET_VALUE)}
                role="option"
                type="button"
              >
                <TtsVendorIcon presetId={null} />
                <span>自定义</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {form.presetId === null && (
        <div className="setting-row">
          <span>
            <strong>协议</strong>
          </span>
          <span className="setting-source-switch">
            {TTS_PROTOCOLS.map((protocol) => (
              <SurfaceButton
                aria-pressed={form.protocol === protocol}
                className="setting-source-option"
                disabled={busy}
                key={protocol}
                onClick={() => onChange(selectProtocol(form, protocol))}
                size="sm"
              >
                {TTS_PROTOCOL_LABELS[protocol]}
              </SurfaceButton>
            ))}
          </span>
        </div>
      )}
      {form.presetId === null && (
        <label className="setting-field">
          <span>端点地址</span>
          <input
            autoComplete="off"
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            value={form.baseUrl}
          />
        </label>
      )}
      <label className="setting-field">
        <span>模型 ID</span>
        <input
          autoComplete="off"
          onChange={(event) => update({ model: event.target.value })}
          placeholder="speech-2.8-turbo"
          spellCheck={false}
          value={form.model}
        />
      </label>
      <label className="setting-field">
        <span>音色 ID</span>
        <input
          autoComplete="off"
          onChange={(event) => update({ voice: event.target.value })}
          placeholder={form.protocol === "chat-audio" ? "可留空使用默认音色" : "必填"}
          spellCheck={false}
          value={form.voice}
        />
      </label>
      <div className="setting-field">
        <span className="setting-field-head">
          <label htmlFor="tts-api-key">API Key{provider?.hasApiKey ? "（已保存）" : ""}</label>
          {preset !== undefined && onOpenApiKey !== undefined && (
            <button
              className="setting-link"
              onClick={() => onOpenApiKey(preset.apiKeyUrl)}
              type="button"
            >
              获取 API Key
            </button>
          )}
        </span>
        <span className="setting-secret-field">
          <input
            autoComplete="off"
            id="tts-api-key"
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder={provider?.hasApiKey ? "留空沿用已保存的 Key" : "必填"}
            spellCheck={false}
            type={revealed ? "text" : "password"}
            value={form.apiKey}
          />
          <Tooltip label={revealed ? "隐藏" : "显示"}>
            <IconButton
              aria-pressed={revealed}
              className="setting-secret-toggle"
              icon={revealed ? EyeOff : Eye}
              label={revealed ? "隐藏密钥" : "显示密钥"}
              onClick={onRevealKey}
              variant="quiet"
            />
          </Tooltip>
        </span>
      </div>
      <div className="setting-model-footer">
        <span className={notice ? "setting-status setting-status--saved" : "setting-status"}>
          {notice || (provider === null ? "尚未配置" : "已配置")}
        </span>
        <span className="setting-model-actions">
          <SurfaceButton
            className="setting-action"
            disabled={busy}
            onClick={onSave}
            size="sm"
            variant="primary"
          >
            保存
          </SurfaceButton>
          {provider !== null && (
            <SurfaceButton disabled={busy} onClick={onClear} size="sm" variant="quiet">
              清除
            </SurfaceButton>
          )}
        </span>
      </div>
    </div>
  );
}
