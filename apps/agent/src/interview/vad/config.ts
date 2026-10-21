import { PCM_FRAME_MAX_SAMPLES } from "../contracts";

/**
 * 会话 VAD 的调参加工值。全部为占位默认值：10-16 Note 约定真实阈值必须等到
 * 阶段 8 用 Windows loopback + 带标注中英文面试样本校准后才能宣称可靠。
 */

/** 分段与事件时间轴统一以 16 kHz 单声道采样计数表示。 */
export const VAD_SAMPLE_RATE = 16_000;

/** TEN VAD 原生分析窗：256 样本 = 16 ms。 */
export const TEN_VAD_HOP_SAMPLES = 256;

/** 喂给 `_ten_vad_create` 的检测阈值；flag 由引擎按该阈值直接给出。 */
export const TEN_VAD_ONSET_THRESHOLD = 0.5;

/** 真语音最短时长：低于该值的短噪声 blip 不产出任何 utterance。 */
export const VAD_MIN_SPEECH_MS = 250;

/** 本地 turn-end 静音闭合窗；TEN semantic VAD 的 500ms 仅作延迟参考。 */
export const VAD_CLOSE_SILENCE_MS = 500;

/** speech-started 事件回溯携带的最长 pre-roll 时长。 */
export const VAD_PRE_ROLL_MS = 300;

/** 单个 chunk 的目标上限；达到后按最低 RMS 强切为 continuation。 */
export const VAD_MAX_CHUNK_MS = 4_500;

/** 强切时与后继 chunk 重放重叠的采样数：1 帧承载，转录按稳定范围去重。 */
export const VAD_CHUNK_OVERLAP_SAMPLES = PCM_FRAME_MAX_SAMPLES;

/**
 * 模块加载完成前每源最多缓冲的 PCM 帧数（面试帧每 100ms 一帧）。
 * 超出即显式失败，不允许无界排队。
 */
export const VAD_WARMUP_PENDING_FRAMES = 16;

/** 音频裂口最多补静默的帧数（8 帧 = 800ms）；更长的裂口记为运行时失败。 */
export const VAD_MAX_GAP_FRAMES = 8;

/** 阶段 3 的分段暂存上限（每会话）；阶段 4 的消费者接管后移除。 */
export const VAD_STAGING_SEGMENT_LIMIT = 32;

/** 将毫秒换算为 VAD_SAMPLE_RATE 下的采样数。 */
export function msToSamples(ms: number): number {
  return Math.round((ms / 1_000) * VAD_SAMPLE_RATE);
}
