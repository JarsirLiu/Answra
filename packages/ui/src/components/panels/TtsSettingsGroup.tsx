/**
 * 设置 →「语音合成」分组：单一 provider 表单。
 *
 * 与「模型」分组一致：直接展示供应商、模型、音色与 Key，不需要先「添加 provider」。
 * 没有独立开关：保存 provider 后演练模式自动朗读，未配置即保持文字模式。
 * 表单细节在 `TtsProviderForm`，本组件只持有设置视图与保存流程。
 * Key 明文仅在用户点「显示」时回填到掩码输入框。
 */
import type { DesktopBridge, TtsSettingsPatch, TtsSettingsView } from "@answra/shared";
import { useEffect, useState } from "react";
import {
  blankProviderForm,
  draftOfForm,
  formOfProvider,
  type TtsProviderFormState,
} from "../../tts/providerDraft";
import { TtsProviderForm as TtsProviderFormView } from "./TtsProviderForm";

export function TtsSettingsGroup({ bridge }: { bridge?: DesktopBridge }) {
  const [view, setView] = useState<TtsSettingsView>();
  const [form, setForm] = useState<TtsProviderFormState>(() => blankProviderForm());
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const getSettings = bridge?.getTtsSettings;
  const saveSettings = bridge?.saveTtsSettings;
  const revealApiKey = bridge?.revealTtsApiKey;

  useEffect(() => {
    if (!getSettings) return;
    let cancelled = false;
    getSettings()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        const provider = next.provider ?? null;
        setForm(provider === null ? blankProviderForm() : formOfProvider(provider));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取语音设置");
      });
    return () => {
      cancelled = true;
    };
  }, [getSettings]);

  if (!getSettings || !saveSettings) return null;
  if (view === undefined) {
    return (
      <section className="settings-group">
        <h2>语音合成</h2>
        <p className="setting-status">正在读取语音设置…</p>
      </section>
    );
  }

  const current = view;
  const save = saveSettings;
  // 切换供应商后 id 会变：旧 Key 不再适用，回填提示与「显示」都必须按当前 id 匹配。
  const savedProvider = current.provider?.id === form.id ? current.provider : null;

  async function apply(patch: TtsSettingsPatch): Promise<TtsSettingsView | undefined> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await save(patch);
      setView(next);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存语音设置失败");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function saveProvider(): Promise<void> {
    const next = await apply({ provider: draftOfForm(form) });
    if (next === undefined || !next.provider) return;
    setForm(formOfProvider(next.provider));
    setRevealed(false);
    setNotice("已保存");
  }

  async function clearProvider(): Promise<void> {
    const next = await apply({ provider: null });
    if (next === undefined) return;
    setForm(blankProviderForm());
    setRevealed(false);
    setNotice("已清除");
  }

  async function showApiKey(): Promise<void> {
    if (!revealApiKey || savedProvider === null || revealed) {
      setRevealed((value) => !value);
      return;
    }
    setError("");
    try {
      const result = await revealApiKey(savedProvider.id);
      if (result.apiKey === null) {
        setError("没有已保存的 API Key");
        return;
      }
      setForm((value) => ({ ...value, apiKey: result.apiKey ?? "" }));
      setRevealed(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取已保存的 API Key");
    }
  }

  return (
    <section className="settings-group">
      <h2>语音合成</h2>

      <TtsProviderFormView
        busy={busy}
        form={form}
        notice={notice}
        onChange={setForm}
        onClear={() => void clearProvider()}
        onOpenApiKey={
          bridge?.openExternal === undefined ? undefined : (url) => void bridge.openExternal?.(url)
        }
        onRevealKey={() => void showApiKey()}
        onSave={() => void saveProvider()}
        provider={savedProvider}
        revealed={revealed}
      />

      {error && (
        <p className="setting-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
