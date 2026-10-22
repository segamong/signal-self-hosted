// Soft downward expansion keeps keyboard and room noise quiet between phrases.
// Opening is faster than closing so the start of a word is preserved.
class SignalVoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.level = 1;
    this.threshold = 10 ** (-56 / 20);
    this.enabled = true;
    this.holdFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (typeof data.enabled === 'boolean') this.enabled = data.enabled;
      if (Number.isFinite(data.threshold)) this.threshold = 10 ** (Math.min(-20, Math.max(-70, data.threshold)) / 20);
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const samples = output[0]?.length || 128;
    let energy = 0;
    const first = input[0];
    if (first) for (const sample of first) energy += sample * sample;
    const loud = first && Math.sqrt(energy / first.length) > this.threshold;
    if (loud) this.holdFrames = sampleRate * 0.12;
    this.holdFrames = Math.max(0, this.holdFrames - samples);
    const target = !this.enabled || this.holdFrames > 0 ? 1 : 0.025;
    const time = target > this.level ? 0.004 : 0.14;
    const coefficient = 1 - Math.exp(-1 / (sampleRate * time));
    for (let index = 0; index < samples; index++) {
      this.level += (target - this.level) * coefficient;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][index] = (input[channel]?.[index] || first?.[index] || 0) * this.level;
      }
    }
    return true;
  }
}
registerProcessor('signal-voice-gate', SignalVoiceGate);
