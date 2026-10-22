import { AudioPresets, type AudioCaptureOptions, type TrackPublishOptions } from 'livekit-client';

export type NoiseEngine = 'browser' | 'rnnoise';
export type VoicePreset = 'natural' | 'balanced' | 'strong';
export interface AudioPreferences {
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseSuppression: boolean;
  noiseEngine: NoiseEngine;
  rnnoisePreset: VoicePreset;
  microphoneGain: number;
  gateEnabled: boolean;
  gateThreshold: number;
}

export const DEFAULT_AUDIO: AudioPreferences = {
  echoCancellation: true, autoGainControl: false, noiseSuppression: false,
  noiseEngine: 'browser', rnnoisePreset: 'balanced', microphoneGain: 100,
  gateEnabled: true, gateThreshold: -56,
};
const STORAGE_KEY = 'signal.audio.v1';

export function loadAudioPreferences(): AudioPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_AUDIO };
    const result = { ...DEFAULT_AUDIO };
    for (const key of ['echoCancellation', 'autoGainControl', 'noiseSuppression', 'gateEnabled'] as const) {
      if (typeof stored[key] === 'boolean') result[key] = stored[key];
    }
    if (stored.noiseEngine === 'rnnoise') result.noiseEngine = 'rnnoise';
    if (['natural', 'balanced', 'strong'].includes(stored.rnnoisePreset)) result.rnnoisePreset = stored.rnnoisePreset;
    if (Number.isFinite(stored.microphoneGain)) result.microphoneGain = Math.min(200, Math.max(0, stored.microphoneGain));
    if (Number.isFinite(stored.gateThreshold)) result.gateThreshold = Math.min(-20, Math.max(-70, stored.gateThreshold));
    return result;
  } catch { return { ...DEFAULT_AUDIO }; }
}

export function saveAudioPreferences(value: AudioPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Session settings remain usable without storage. */ }
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
