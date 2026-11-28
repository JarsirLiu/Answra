/**
 * 麦克风采集 worklet：把任意设备采样率压到 16 kHz PCM16，并按 credit 发出 100 ms 帧。
 * 设备采样率常是 44.1/48 kHz；这里用分数相位重采样，避免把 48k 样本当 16k 送给 VAD/ASR。
 */
class AnswraPcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.credits = 0;
    this.maxCredits = 0;
    this.sequence = 0;
    this.startSample = 0;
    this.source = "interviewer";
    this.samples = new Int16Array(1600);
    this.offset = 0;
    this.resampleRatio = 1;
    this.resamplePhase = 0;
    this.resampleAccumulator = 0;
    this.resampleCount = 0;
    this.squareSum = 0;
    this.levelCount = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "start") {
        this.source = data.source === "candidate" ? "candidate" : "interviewer";
        this.maxCredits = Math.max(0, data.maxCredits | 0);
        this.credits = Math.max(0, Math.min(this.maxCredits, data.credits | 0));
        this.resampleRatio = computeResampleRatio(data.sampleRate);
        this.resamplePhase = 0;
        this.resampleAccumulator = 0;
        this.resampleCount = 0;
        this.active = true;
      }
      if (data?.type === "credit") {
        this.credits = Math.max(0, Math.min(this.maxCredits, this.credits + (data.count | 0)));
      }
      if (data?.type === "stop") {
        this.flush();
        this.active = false;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }
    if (!this.active || !input || input.length === 0) return true;

    const length = input[0]?.length ?? 0;
    for (let index = 0; index < length; index += 1) {
      let mono = 0;
      for (const channel of input) mono += channel[index] ?? 0;
      mono /= input.length;
      this.pushSample(mono);
    }
    return true;
  }

  pushSample(sample) {
    const bounded = Math.max(-1, Math.min(1, sample));
    this.resampleAccumulator += bounded;
    this.resampleCount += 1;
    this.resamplePhase += 1;
    if (this.resamplePhase < this.resampleRatio) return;

    // 分数相位重采样：44.1k 之类的输入平均落在 16k，而不是被整数比拖慢。
    this.resamplePhase -= this.resampleRatio;
    const resampled = this.resampleAccumulator / this.resampleCount;
    this.resampleAccumulator = 0;
    this.resampleCount = 0;
    this.squareSum += resampled * resampled;
    this.levelCount += 1;
    this.samples[this.offset++] =
      resampled < 0 ? Math.round(resampled * 32768) : Math.round(resampled * 32767);
    if (this.offset === this.samples.length) this.flush();
  }

  flush() {
    if (this.offset === 0) return;
    const pcm = this.samples.slice(0, this.offset).buffer;
    const sequence = this.sequence++;
    const startSample = this.startSample;
    this.startSample += this.offset;
    // 电平独立于 credit：丢帧时仍然让 UI 看到麦克风输入是否有效。
    const rms = this.levelCount > 0 ? Math.sqrt(this.squareSum / this.levelCount) : 0;
    this.port.postMessage({ type: "level", level: Math.min(1, rms) });
    if (this.credits > 0) {
      this.credits -= 1;
      this.port.postMessage({ type: "frame", source: this.source, sequence, startSample, pcm }, [
        pcm,
      ]);
    }
    this.samples = new Int16Array(1600);
    this.offset = 0;
    this.squareSum = 0;
    this.levelCount = 0;
  }
}

/** 输入采样率不合法时按 16k 处理；低于 16k 不做上采样，最多保持原速率。 */
function computeResampleRatio(inputSampleRate) {
  const fallback = typeof sampleRate === "number" ? sampleRate : 16_000;
  const rate = Number.isFinite(inputSampleRate) && inputSampleRate > 0 ? inputSampleRate : fallback;
  return Math.max(1, rate / 16_000);
}

registerProcessor("answra-pcm16-capture", AnswraPcmFrameProcessor);
