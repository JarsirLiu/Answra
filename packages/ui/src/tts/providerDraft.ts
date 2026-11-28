import {
  TTS_PROTOCOL_PRESETS,
  TTS_PROVIDER_CATALOG,
  type TtsProtocol,
  type TtsProviderConfig,
  type TtsProviderDraft,
  type TtsProviderPreset,
} from "@answra/shared";

/**
 * 设置表单状态。
 *
 * `apiKey` 只在渲染层内存里，保存后不回读；`presetId` 表示当前套用的目录项，
 * `null` 表示自定义（含已手改字段），仅用于展示与图标，不进入保存载荷。
 * `id` 是 keychain account 后缀，不在设置页展示；仅切换厂商时变化。
 */
export interface TtsProviderFormState {
  readonly id: string;
  readonly label: string;
  readonly protocol: TtsProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
  readonly apiKey: string;
  readonly presetId: string | null;
}

/** 「自定义」不是目录项，用独立哨兵值区分，避免与真实 id 冲突。 */
export const CUSTOM_PRESET_VALUE = "custom";
export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_PROVIDER_LABEL = "自定义";

/**
 * 套用目录项：覆盖协议、端点、模型、音色与显示名称（目录是明确选中的初值）。
 *
 * API Key 一并清空：Key 属于具体厂商，换成另一家后沿用旧 Key 只会得到鉴权失败。
 * 同一目录项重复选中时保持原样（包括用户已经手改过的字段与 id）。
 */
export function applyPreset(
  preset: TtsProviderPreset,
  form?: TtsProviderFormState,
): TtsProviderFormState {
  if (form?.presetId === preset.id) return form;
  return {
    id: preset.id,
    label: preset.label,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: preset.model,
    voice: preset.voice,
    apiKey: "",
    presetId: preset.id,
  };
}

/** 未配置时的初始表单：默认选中目录第一条，字段已填好，只需补 Key。 */
export function blankProviderForm(): TtsProviderFormState {
  const first = TTS_PROVIDER_CATALOG[0];
  if (first === undefined) throw new Error("TTS 厂商目录为空");
  return applyPreset(first);
}

/** 切到自定义：保留当前端点/模型作为起点，但清空 Key 与目录身份。 */
export function selectCustom(form: TtsProviderFormState): TtsProviderFormState {
  if (form.presetId === null) return form;
  return {
    ...form,
    id: CUSTOM_PROVIDER_ID,
    label: CUSTOM_PROVIDER_LABEL,
    apiKey: "",
    presetId: null,
  };
}

/**
 * 自定义模式切协议：只覆盖仍等于旧协议预设的字段，用户手改过的端点/模型不被冲掉。
 *
 * 切换后不再是目录项，`presetId` 归零。
 */
export function selectProtocol(
  form: TtsProviderFormState,
  protocol: TtsProtocol,
): TtsProviderFormState {
  const next = TTS_PROTOCOL_PRESETS[protocol];
  const previous = TTS_PROTOCOL_PRESETS[form.protocol];
  return {
    ...form,
    protocol,
    baseUrl: form.baseUrl === previous.baseUrl ? next.baseUrl : form.baseUrl,
    model: form.model === previous.model ? next.model : form.model,
    voice: form.voice === previous.voice ? next.voice : form.voice,
    presetId: null,
  };
}

/**
 * 已保存 provider 命中目录项时返回其 id，用于回显「供应商」。
 *
 * 厂商身份由协议 + 端点 + 模型决定；音色是用户可调参数，改了以后仍算同一家厂商。
 */
export function matchPresetId(provider: TtsProviderConfig): string | null {
  const matched = TTS_PROVIDER_CATALOG.find(
    (preset) =>
      preset.protocol === provider.protocol &&
      preset.baseUrl === provider.baseUrl &&
      preset.model === provider.model,
  );
  return matched?.id ?? null;
}

/** 已保存 provider：字段回填，Key 不回读（留空表示沿用已保存的 Key）。 */
export function formOfProvider(provider: TtsProviderConfig): TtsProviderFormState {
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    model: provider.model,
    voice: provider.voice,
    apiKey: "",
    presetId: matchPresetId(provider),
  };
}

/** 表单 → 保存载荷；Key 留空时不带 `apiKey`，由 main 沿用已保存值。 */
export function draftOfForm(form: TtsProviderFormState): TtsProviderDraft {
  const apiKey = form.apiKey.trim();
  return {
    id: form.id.trim(),
    label: form.label.trim(),
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    voice: form.voice.trim(),
    ...(apiKey === "" ? {} : { apiKey }),
  };
}
