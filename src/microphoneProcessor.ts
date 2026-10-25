import { LocalAudioTrack, Track, TrackEvent, type AudioProcessorOptions, type Room, type TrackProcessor } from 'livekit-client';
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimd from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import gateWorklet from './voice-gate.worklet.js?url&no-inline';
import { microphoneCapture, type AudioPreferences } from './audioPreferences';
import { createNeuralNoise, type NeuralNoise } from './neuralNoise';

const modules = new WeakMap<AudioContext, Map<string, Promise<void>>>();
const changes = new WeakMap<LocalAudioTrack, Promise<void>>();
const pushToTalkStates = new WeakMap<LocalAudioTrack, boolean>();
let binary: Promise<ArrayBuffer> | undefined;
type ProcessingErrorListener = (track: LocalAudioTrack, error: Error) => void;
const processingErrors = new Set<ProcessingErrorListener>();
export function onMicrophoneProcessingError(listener: ProcessingErrorListener): () => void {
  processingErrors.add(listener);
  return () => { processingErrors.delete(listener); };
}
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
  private neural?: NeuralNoise;
  private pushToTalkPressed = false;
  private transmitGain?: GainNode;
  private localTrack?: LocalAudioTrack;
  private generation = 0;
  private lifecycle?: AbortController;
  private readonly syncMuted = () => this.updateTransmitGain(true);
  constructor(private preferences: AudioPreferences, private readonly currentPushToTalk: () => boolean) {}

  async init(options: AudioProcessorOptions) {
    const generation = ++this.generation;
    this.lifecycle?.abort();
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    const ensureCurrent = () => {
      const localTrack = options.localTrack instanceof LocalAudioTrack ? options.localTrack : undefined;
      // stopOnMute intentionally ends a muted capture; the SDK may rebuild its
      // processor around it before reacquiring the device on a later unmute.
      if (generation !== this.generation || lifecycle.signal.aborted || (options.track.readyState !== 'live' && !localTrack?.isMuted) || localTrack?.isStopped) {
        throw new DOMException('Запуск обработки микрофона отменён.', 'AbortError');
      }
    };
    let context = options.audioContext;
    try {
      ensureCurrent();
      this.localTrack = options.localTrack instanceof LocalAudioTrack ? options.localTrack : undefined;
      this.localTrack?.on(TrackEvent.Muted, this.syncMuted);
      this.localTrack?.on(TrackEvent.Unmuted, this.syncMuted);
      if (options.track.readyState === 'live') {
        // SDK unmute can reacquire a stopped capture with its previous constraints.
        // Apply the selected profile before exposing the restarted processed track.
        await options.track.applyConstraints({
          echoCancellation: this.preferences.echoCancellation,
          autoGainControl: this.preferences.autoGainControl,
          noiseSuppression: this.preferences.noiseEngine === 'browser' && this.preferences.noiseSuppression,
        });
        ensureCurrent();
      }
      if (this.preferences.noiseEngine !== 'browser' && context.sampleRate !== 48_000) {
        this.ownedContext = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
        context = this.ownedContext;
        await context.resume();
        ensureCurrent();
      }
      if (this.preferences.noiseEngine === 'neural' && context.state === 'suspended') {
        await context.resume();
        ensureCurrent();
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
        ensureCurrent();
        const noise = new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
        this.noise = noise;
        this.nodes.push(noise);
        end.connect(noise);
        end = noise;
      }
      if (this.preferences.noiseEngine === 'neural') {
        const neural = await createNeuralNoise(context, error => {
          if (generation === this.generation && !lifecycle.signal.aborted) this.processingFailed(error);
        }, lifecycle.signal);
        try { ensureCurrent(); }
        catch (error) { neural.destroy(); throw error; }
        this.neural = neural;
        this.nodes.push(neural.input);
        end.connect(neural.input);
        end = neural.output;
      }
      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        await addModule(context, gateWorklet);
        ensureCurrent();
        this.gate = new AudioWorkletNode(context, 'signal-voice-gate');
        this.nodes.push(this.gate);
        end.connect(this.gate);
        end = this.gate;
      } else if (this.preferences.gateEnabled && this.preferences.inputMode !== 'push-to-talk') {
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
      // The key may have been released while worklet modules were loading.
      this.pushToTalkPressed = this.currentPushToTalk();
      this.transmitGain = context.createGain();
      // Keep a newly created push-to-talk chain silent before publication.
      this.transmitGain.gain.value = this.localTrack?.isMuted || this.preferences.inputMode === 'push-to-talk' ? 0 : 1;
      this.nodes.push(this.gain, limiter, this.transmitGain, destination);
      end.connect(this.gain).connect(limiter).connect(this.transmitGain).connect(destination);
      this.processedTrack = destination.stream.getAudioTracks()[0];
      this.update(this.preferences);
    } catch (error) {
      // A cancelled old init must not tear down the graph of a later restart.
      if (generation === this.generation) await this.destroy();
      throw error;
    }
  }

  update(value: AudioPreferences) {
    const modeChanged = value.inputMode !== this.preferences.inputMode;
    if (modeChanged) this.pushToTalkPressed = false;
    this.preferences = { ...value };
    if (!this.context) return;
    this.gain?.gain.setTargetAtTime(value.microphoneGain / 100, this.context.currentTime, 0.02);
    // RNNoise always runs once. Presets adjust the residual room-noise gate
    // and bass cut rather than stacking browser and neural suppressors.
    const profile = value.noiseEngine === 'neural' ? value.neuralPreset : value.rnnoisePreset;
    const offset = value.noiseEngine === 'browser' ? 0 : profile === 'natural' ? -8 : profile === 'strong' ? 8 : 0;
    this.gate?.port.postMessage({
      enabled: value.gateEnabled && value.inputMode !== 'push-to-talk',
      threshold: value.gateThreshold + offset,
      thresholdOffset: offset,
      automatic: value.settingsMode === 'discord' && value.automaticSensitivity,
      releaseDelay: value.releaseDelay,
      hardGate: value.settingsMode === 'discord',
    });
    this.filter?.frequency.setTargetAtTime(value.noiseEngine !== 'browser' && profile === 'strong' ? 100 : 65, this.context.currentTime, 0.03);
    this.updateTransmitGain(modeChanged);
  }

  setPushToTalk(pressed: boolean, immediate = false) {
    this.pushToTalkPressed = pressed;
    this.updateTransmitGain(immediate);
  }

  private updateTransmitGain(immediate = false) {
    if (!this.context || !this.transmitGain) return;
    const now = this.context.currentTime;
    const transmitting = !this.localTrack?.isMuted && (this.preferences.inputMode !== 'push-to-talk' || this.pushToTalkPressed);
    const parameter = this.transmitGain.gain;
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(parameter.value, now);
    if (!transmitting && immediate) parameter.setValueAtTime(0, now);
    else if (transmitting) parameter.linearRampToValueAtTime(1, now + 0.004);
    else if (parameter.value > 0) {
      const releaseAt = now + this.preferences.releaseDelay / 1000;
      parameter.setValueAtTime(parameter.value, releaseAt);
      parameter.linearRampToValueAtTime(0, releaseAt + 0.008);
    } else parameter.setValueAtTime(0, now);
  }

  requiresRestart(value: AudioPreferences) {
    const previous = this.preferences;
    return previous.noiseEngine !== value.noiseEngine || previous.echoCancellation !== value.echoCancellation
      || previous.autoGainControl !== value.autoGainControl || previous.noiseSuppression !== value.noiseSuppression
      || !this.context || this.processedTrack?.readyState !== 'live';
  }
  private processingFailed(error: Error) {
    const track = this.localTrack;
    if (!track) return;
    // Also cancels any remaining asynchronous init steps if the model failed
    // immediately after reporting ready, before the rest of the graph existed.
    this.lifecycle?.abort();
    if (this.context && this.transmitGain) {
      this.transmitGain.gain.cancelScheduledValues(this.context.currentTime);
      this.transmitGain.gain.setValueAtTime(0, this.context.currentTime);
    }
    this.processedTrack?.stop();
    void track.mute().catch(() => {});
    for (const listener of processingErrors) {
      try { listener(track, error); } catch { /* One view cannot prevent muting. */ }
    }
  }
  async restart(options: AudioProcessorOptions) {
    const destroying = this.destroy();
    const generation = this.generation;
    await destroying;
    // stop() can arrive while an owned audio context is closing.
    if (generation !== this.generation || (options.localTrack instanceof LocalAudioTrack && options.localTrack.isStopped)) {
      throw new DOMException('Перезапуск обработки микрофона отменён.', 'AbortError');
    }
    await this.init(options);
  }
  async destroy() {
    ++this.generation;
    this.lifecycle?.abort();
    this.lifecycle = undefined;
    this.localTrack?.off(TrackEvent.Muted, this.syncMuted);
    this.localTrack?.off(TrackEvent.Unmuted, this.syncMuted);
    this.localTrack = undefined;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.noise?.destroy();
    this.noise = undefined;
    this.neural?.destroy();
    this.neural = undefined;
    this.gate = undefined;
    this.gain = undefined;
    this.transmitGain = undefined;
    this.filter = undefined;
    const owned = this.ownedContext;
    this.ownedContext = undefined;
    this.context = undefined;
    if (owned && owned.state !== 'closed') await owned.close();
  }
}

/** Controls only outgoing microphone audio; screen sound and mute state are untouched. */
export function setMicrophonePushToTalk(room: Room, pressed: boolean, immediate = false) {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (track instanceof LocalAudioTrack) pushToTalkStates.set(track, pressed);
  const processor = track instanceof LocalAudioTrack ? track.getProcessor() : undefined;
  if (processor instanceof VoiceProcessor) processor.setPushToTalk(pressed, immediate);
}

export async function applyMicrophoneProcessing(room: Room, preferences: AudioPreferences) {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!(track instanceof LocalAudioTrack)) return;
  await processMicrophoneTrack(track, preferences);
}

export async function processMicrophoneTrack(track: LocalAudioTrack, preferences: AudioPreferences) {
  const previous = changes.get(track) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (track.isStopped) throw new Error('Дорожка микрофона завершена. Подключитесь к звонку заново.');
    const existing = track.getProcessor();
    const source = track.mediaStream?.getAudioTracks()[0] ?? track.mediaStreamTrack;
    if (existing instanceof VoiceProcessor) {
      const restartRequired = existing.requiresRestart(preferences);
      existing.update(preferences);
      // An ended source is reacquired by SDK unmute; its retained processor
      // must already hold the new profile, including a changed noise engine.
      if (restartRequired && (source.readyState === 'live' || !track.isMuted)) {
        await track.restartTrack({ ...microphoneCapture(preferences), deviceId: source.getSettings().deviceId || undefined });
      }
      return;
    }
    const processor = new VoiceProcessor(preferences, () => pushToTalkStates.get(track) ?? false);
    processor.setPushToTalk(pushToTalkStates.get(track) ?? false);
    try { await track.setProcessor(processor); }
    catch (error) { await processor.destroy(); throw error; }
  });
  changes.set(track, next);
  try { await next; }
  finally { if (changes.get(track) === next) changes.delete(track); }
}
