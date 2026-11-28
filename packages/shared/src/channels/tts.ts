/**
 * 语音合成频道：设置读写与手动朗读走 invoke，音频与停止由 main 推送。
 *
 * 音频字节只存在于 main → renderer 这一跳；不落盘、不进 transcript、不进 agent。
 */
import type {
  TtsAudioFrame,
  TtsFailureEvent,
  TtsSettingsPatch,
  TtsSettingsView,
  TtsSpeakRequest,
  TtsStopPayload,
} from "../tts";

export const TtsChannels = {
  /** 读取 TTS 设置摘要（不含任何 Key 明文）。 */
  GetSettings: "answra:tts:get-settings",
  /** 保存设置，返回归一化后的摘要。 */
  SaveSettings: "answra:tts:save-settings",
  /** 仅在设置页需要明文时读取某个 provider 的 Key。 */
  RevealApiKey: "answra:tts:reveal-api-key",
  /** 手动朗读一条消息；合成结果经 `Audio` 推送。 */
  Speak: "answra:tts:speak",
  /** 停止播放；`conversationId: null` 表示停止全部。 */
  Stop: "answra:tts:stop",
  /** main 推送合成好的音频帧。 */
  Audio: "answra:tts:audio",
  /** main 推送停止信号（切换模式、新 run、停止会话）。 */
  Stopped: "answra:tts:stopped",
  /** main 推送合成失败；渲染层只提示，不弹全局错误。 */
  Failed: "answra:tts:failed",
} as const;

export interface TtsChannelMap {
  [TtsChannels.GetSettings]: { request: undefined; response: TtsSettingsView };
  [TtsChannels.SaveSettings]: { request: TtsSettingsPatch; response: TtsSettingsView };
  [TtsChannels.RevealApiKey]: {
    request: { providerId: string };
    response: { apiKey: string | null };
  };
  [TtsChannels.Speak]: { request: TtsSpeakRequest; response: { accepted: boolean } };
  [TtsChannels.Stop]: { request: TtsStopPayload; response: undefined };
  [TtsChannels.Audio]: { request: TtsAudioFrame; response: undefined };
  [TtsChannels.Stopped]: { request: TtsStopPayload; response: undefined };
  [TtsChannels.Failed]: { request: TtsFailureEvent; response: undefined };
}
