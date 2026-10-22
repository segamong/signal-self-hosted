import { LocalAudioTrack, Track, type AudioProcessorOptions, type Room, type TrackProcessor } from 'livekit-client';
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimd from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import gateWorklet from './voice-gate.worklet.js?url&no-inline';
import type { AudioPreferences } from './audioPreferences';

const modules = new WeakMap<AudioContext, Map<string, Promise<void>>>();
const changes = new WeakMap<LocalAudioTrack, Promise<void>>();
let binary: Promise<ArrayBuffer> | undefined;
function addModule(context: AudioContext, url: string) {
  let loading = modules.get(context);
  if (!loading) { loading = new Map(); modules.set(context, loading); }
  let result = loading.get(url);
  if (!result) {
    result = context.audioWorklet.addModule(url).catch(error => { loading!.delete(url); throw error; });
    loading.set(url, result);
  }
  return result;
}

class VoiceProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'signal-voice-processing';
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  private ownedContext?: AudioContext;
  private nodes: AudioNode[] = [];
  private gain?: GainNode;
  private gate?: AudioWorkletNode;
  private filter?: BiquadFilterNode;
  private noise?: RnnoiseWorkletNode;
  constructor(private preferences: AudioPreferences) {}

  async init(options: AudioProcessorOptions) {
    let context = options.audioContext;
    try {
      if (this.preferences.noiseEngine === 'rnnoise' && context.sampleRate !== 48_000) {
        this.ownedContext = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
        context = this.ownedContext;
        await context.resume();
      }
      this.context = context;
      const source = context.createMediaStreamSource(new MediaStream([options.track]));
      const filter = context.createBiquadFilter();
      filter.type = 'highpass';
      this.filter = filter;
      this.nodes.push(source, filter);
      source.connect(filter);
      let end: AudioNode = filter;
      if (this.preferences.noiseEngine === 'rnnoise') {
        if (!context.audioWorklet || context.sampleRate !== 48_000) throw new Error('Для RNNoise нужен браузер с AudioWorklet и звуком 48 кГц. Выберите обработку браузера.');
        binary ??= loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimd }).catch(error => { binary = undefined; throw error; });
        const [wasmBinary] = await Promise.all([binary, addModule(context, rnnoiseWorklet)]);
        const noise = new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
        this.noise = noise;
        this.nodes.push(noise);
        end.connect(noise);
        end = noise;
      }
      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        await addModule(context, gateWorklet);
        this.gate = new AudioWorkletNode(context, 'signal-voice-gate');
        this.nodes.push(this.gate);
        end.connect(this.gate);
        end = this.gate;
      } else if (this.preferences.gateEnabled) {
        throw new Error('Порог микрофона требует AudioWorklet. Отключите порог или обновите браузер.');
      }
      this.gain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 2;
      limiter.ratio.value = 15;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.09;
      const destination = context.createMediaStreamDestination();
      this.nodes.push(this.gain, limiter, destination);
      end.connect(this.gain).connect(limiter).connect(destination);
      this.processedTrack = destination.stream.getAudioTracks()[0];
      this.update(this.preferences);
    } catch (error) { await this.destroy(); throw error; }
  }

  update(value: AudioPreferences) {
    this.preferences = { ...value };
    if (!this.context) return;
    this.gain?.gain.setTargetAtTime(value.microphoneGain / 100, this.context.currentTime, 0.02);
    // RNNoise always runs once. Presets adjust the residual room-noise gate
    // and bass cut rather than stacking browser and neural suppressors.
    const offset = value.noiseEngine !== 'rnnoise' ? 0 : value.rnnoisePreset === 'natural' ? -8 : value.rnnoisePreset === 'strong' ? 8 : 0;
    this.gate?.port.postMessage({ enabled: value.gateEnabled, threshold: value.gateThreshold + offset });
    this.filter?.frequency.setTargetAtTime(value.noiseEngine === 'rnnoise' && value.rnnoisePreset === 'strong' ? 100 : 65, this.context.currentTime, 0.03);
  }

  getEngine() { return this.preferences.noiseEngine; }
  async restart(options: AudioProcessorOptions) { await this.destroy(); await this.init(options); }
  async destroy() {
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.noise?.destroy();
    this.noise = undefined;
    this.gate = undefined;
    this.gain = undefined;
    this.filter = undefined;
    const owned = this.ownedContext;
    this.ownedContext = undefined;
    this.context = undefined;
    if (owned && owned.state !== 'closed') await owned.close();
  }
}

export async function applyMicrophoneProcessing(room: Room, preferences: AudioPreferences) {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!(track instanceof LocalAudioTrack)) return;
  await processMicrophoneTrack(track, preferences);
}

export async function processMicrophoneTrack(track: LocalAudioTrack, preferences: AudioPreferences) {
  const previous = changes.get(track) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (track.mediaStreamTrack.readyState !== 'live') return;
    const existing = track.getProcessor();
    if (existing instanceof VoiceProcessor && existing.getEngine() === preferences.noiseEngine) {
      existing.update(preferences);
      return;
    }
    const processor = new VoiceProcessor(preferences);
    try { await track.setProcessor(processor); }
    catch (error) { await processor.destroy(); throw error; }
  });
  changes.set(track, next);
  try { await next; }
  finally { if (changes.get(track) === next) changes.delete(track); }
}
