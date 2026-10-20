class AnswraPcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.credits = 0;
    this.maxCredits = 0;
    this.sequence = 0;
    this.startSample = 0;
    this.samples = new Int16Array(1600);
    this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "start") {
        this.maxCredits = Math.max(0, data.maxCredits | 0);
        this.credits = Math.max(0, Math.min(this.maxCredits, data.credits | 0));
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
      const bounded = Math.max(-1, Math.min(1, mono));
      this.samples[this.offset++] = bounded < 0 ? bounded * 32768 : bounded * 32767;
      if (this.offset === this.samples.length) this.flush();
    }
    return true;
  }

  flush() {
    if (this.offset === 0) return;
    const pcm = this.samples.slice(0, this.offset).buffer;
    const sequence = this.sequence++;
    const startSample = this.startSample;
    this.startSample += this.offset;
    if (this.credits > 0) {
      this.credits -= 1;
      this.port.postMessage({ type: "frame", sequence, startSample, pcm }, [pcm]);
    }
    this.samples = new Int16Array(1600);
    this.offset = 0;
  }
}

registerProcessor("answra-pcm16-capture", AnswraPcmFrameProcessor);
