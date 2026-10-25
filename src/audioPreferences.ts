import { AudioPresets, type AudioCaptureOptions, type TrackPublishOptions } from 'livekit-client';

export type NoiseEngine = 'browser' | 'rnnoise' | 'neural';
export type VoicePreset = 'natural' | 'balanced' | 'strong';
export type VoiceSettingsMode = 'signal' | 'discord';
export type VoiceInputMode = 'voice' | 'push-to-talk';
export interface AudioPreferences {
  settingsMode: VoiceSettingsMode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseSuppression: boolean;
  noiseEngine: NoiseEngine;
  rnnoisePreset: VoicePreset;
  neuralPreset: VoicePreset;
  microphoneGain: number;
  outputVolume: number;
  gateEnabled: boolean;
  gateThreshold: number;
  inputMode: VoiceInputMode;
  automaticSensitivity: boolean;
  releaseDelay: number;
  pushToTalkKey: string;
}

export const DEFAULT_AUDIO: AudioPreferences = {
  settingsMode: 'signal',
  echoCancellation: true, autoGainControl: false, noiseSuppression: false,
  noiseEngine: 'browser', rnnoisePreset: 'balanced', neuralPreset: 'balanced', microphoneGain: 100, outputVolume: 100,
  gateEnabled: true, gateThreshold: -56,
  inputMode: 'voice', automaticSensitivity: false, releaseDelay: 120, pushToTalkKey: 'Space',
};
export const DISCORD_AUDIO: AudioPreferences = {
  ...DEFAULT_AUDIO, settingsMode: 'discord', autoGainControl: true, noiseSuppression: true,
  gateEnabled: true, automaticSensitivity: true, releaseDelay: 200,
};
const STORAGE_KEY = 'signal.audio.v2';
const LEGACY_STORAGE_KEY = 'signal.audio.v1';

function normalizeAudioPreferences(stored: unknown, mode: VoiceSettingsMode): AudioPreferences {
  const result = { ...(mode === 'discord' ? DISCORD_AUDIO : DEFAULT_AUDIO) };
  if (!stored || typeof stored !== 'object') return result;
  const value = stored as Record<string, unknown>;
  for (const key of ['echoCancellation', 'autoGainControl', 'noiseSuppression', 'gateEnabled', 'automaticSensitivity'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (value.noiseEngine === 'browser' || value.noiseEngine === 'rnnoise' || value.noiseEngine === 'neural') result.noiseEngine = value.noiseEngine;
  if (value.rnnoisePreset === 'natural' || value.rnnoisePreset === 'balanced' || value.rnnoisePreset === 'strong') result.rnnoisePreset = value.rnnoisePreset;
  if (value.neuralPreset === 'natural' || value.neuralPreset === 'balanced' || value.neuralPreset === 'strong') result.neuralPreset = value.neuralPreset;
  if (typeof value.microphoneGain === 'number' && Number.isFinite(value.microphoneGain)) result.microphoneGain = Math.min(200, Math.max(0, value.microphoneGain));
  if (typeof value.outputVolume === 'number' && Number.isFinite(value.outputVolume)) result.outputVolume = Math.min(200, Math.max(0, value.outputVolume));
  if (typeof value.gateThreshold === 'number' && Number.isFinite(value.gateThreshold)) result.gateThreshold = Math.min(-20, Math.max(-70, value.gateThreshold));
  if (typeof value.releaseDelay === 'number' && Number.isFinite(value.releaseDelay)) result.releaseDelay = Math.min(2000, Math.max(20, value.releaseDelay));
  if (value.inputMode === 'voice' || value.inputMode === 'push-to-talk') result.inputMode = value.inputMode;
  if (isPushToTalkKey(value.pushToTalkKey)) result.pushToTalkKey = value.pushToTalkKey;
  if (mode === 'signal') { result.inputMode = 'voice'; result.automaticSensitivity = false; }
  return result;
}

export function isPushToTalkKey(value: unknown): value is string {
  return typeof value === 'string' && /^(?:Space|Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|ControlLeft|ControlRight|AltLeft|AltRight|ShiftLeft|ShiftRight|Backquote|CapsLock)$/.test(value);
}

export function pushToTalkKeyLabel(code: string): string {
  return ({ Space: 'Пробел', ControlLeft: 'Левый Ctrl', ControlRight: 'Правый Ctrl', AltLeft: 'Левый Alt', AltRight: 'Правый Alt', ShiftLeft: 'Левый Shift', ShiftRight: 'Правый Shift', Backquote: 'Ё / `', CapsLock: 'Caps Lock' } as Record<string, string>)[code]
    || code.replace(/^Key|^Digit/, '');
}

interface StoredAudioProfiles {
  mode: VoiceSettingsMode;
  signal: AudioPreferences;
  discord: AudioPreferences;
}

function loadProfiles(): StoredAudioProfiles {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (stored && typeof stored === 'object') return {
      mode: stored.mode === 'discord' ? 'discord' : 'signal',
      signal: normalizeAudioPreferences(stored.signal, 'signal'),
      discord: normalizeAudioPreferences(stored.discord, 'discord'),
    };
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
    return { mode: 'signal', signal: normalizeAudioPreferences(legacy, 'signal'), discord: { ...DISCORD_AUDIO } };
  } catch { return { mode: 'signal', signal: { ...DEFAULT_AUDIO }, discord: { ...DISCORD_AUDIO } }; }
}

export function loadAudioPreferences(): AudioPreferences {
  const profiles = loadProfiles();
  return { ...profiles[profiles.mode] };
}

/** Switching profiles restores that profile's own saved controls. */
export function preferencesForMode(mode: VoiceSettingsMode): AudioPreferences {
  return { ...loadProfiles()[mode] };
}

export function saveAudioPreferences(value: AudioPreferences) {
  try {
    const profiles = loadProfiles();
    profiles.mode = value.settingsMode;
    profiles[value.settingsMode] = normalizeAudioPreferences(value, value.settingsMode);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch { /* Session settings remain usable without storage. */ }
}

export function microphoneCapture(value: AudioPreferences): AudioCaptureOptions {
  return {
    echoCancellation: value.echoCancellation, autoGainControl: value.autoGainControl,
    noiseSuppression: value.noiseEngine === 'browser' && value.noiseSuppression,
    voiceIsolation: false, channelCount: 1, sampleRate: 48_000,
  };
}

export const VOICE_ENCODING: TrackPublishOptions = {
  audioPreset: { ...AudioPresets.musicHighQuality, priority: 'high' },
  forceStereo: false, dtx: false, red: true,
};
