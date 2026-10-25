// Soft downward expansion keeps keyboard and room noise quiet between phrases.
// Opening is faster than closing so the start of a word is preserved.
class SignalVoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.level = 1;
    this.threshold = 10 ** (-56 / 20);
    this.thresholdOffset = 0;
    this.enabled = true;
    this.automatic = false;
    this.hardGate = false;
    this.releaseDelay = 0.12;
    this.noiseFloor = 10 ** (-60 / 20);
    this.minimum = 1;
    this.minimumFrames = 0;
    this.holdFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (typeof data.enabled === 'boolean') this.enabled = data.enabled;
      if (Number.isFinite(data.threshold)) this.threshold = 10 ** (Math.min(-20, Math.max(-70, data.threshold)) / 20);
      if (Number.isFinite(data.thresholdOffset)) this.thresholdOffset = Math.min(8, Math.max(-8, data.thresholdOffset));
      if (typeof data.automatic === 'boolean') this.automatic = data.automatic;
      if (typeof data.hardGate === 'boolean') this.hardGate = data.hardGate;
      if (Number.isFinite(data.releaseDelay)) this.releaseDelay = Math.min(2000, Math.max(20, data.releaseDelay)) / 1000;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const samples = output[0]?.length || 128;
    let energy = 0;
    const first = input[0];
    if (first) for (const sample of first) energy += sample * sample;
    const rms = first?.length ? Math.sqrt(energy / first.length) : 0;
    // A rolling minimum follows room noise without treating each spoken word
    // as a new background level. A quiet interval lowers the floor faster.
    this.minimum = Math.min(this.minimum, rms);
    this.minimumFrames += samples;
    if (this.minimumFrames >= sampleRate) {
      const measured = Math.max(10 ** (-75 / 20), this.minimum);
      const coefficient = measured < this.noiseFloor ? 0.55 : 0.12;
      this.noiseFloor += (measured - this.noiseFloor) * coefficient;
      this.minimum = 1;
      this.minimumFrames = 0;
    }
    const threshold = this.automatic
      ? Math.min(10 ** (-26 / 20), Math.max(10 ** (-65 / 20), this.noiseFloor * 10 ** ((9 + this.thresholdOffset) / 20)))
      : this.threshold;
    const loud = first && rms > threshold;
    if (loud) this.holdFrames = sampleRate * this.releaseDelay;
    this.holdFrames = Math.max(0, this.holdFrames - samples);
    const target = !this.enabled || this.holdFrames > 0 ? 1 : this.hardGate ? 0 : 0.025;
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
