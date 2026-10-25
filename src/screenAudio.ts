type OwnAudioConstraints = MediaTrackConstraints & { restrictOwnAudio: boolean };
type OwnAudioSettings = MediaTrackSettings & { restrictOwnAudio?: boolean };
type SupportedScreenConstraints = MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean };

export type ScreenAudioMode = 'none' | 'tab' | 'isolated' | 'system';

export function supportsScreenAudioExclusion(
  supportedConstraints: SupportedScreenConstraints,
  trustedDesktop = false,
): boolean {
  return trustedDesktop || supportedConstraints.restrictOwnAudio === true;
}

export interface ScreenAudioCaptureOptions {
  audio: OwnAudioConstraints | false;
  systemAudio: 'include' | 'exclude';
}

/** Pair with selfBrowserSurface: 'exclude' so captured tab audio cannot be this call. */
export function screenAudioCaptureOptions(
  shareAudio: boolean,
  supportedConstraints: SupportedScreenConstraints,
  trustedDesktop = false,
  allowSystemLoopback = false,
): ScreenAudioCaptureOptions {
  const canExclude = supportsScreenAudioExclusion(supportedConstraints, trustedDesktop);
  return {
    audio: shareAudio ? {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      // Compatibility is an explicit opt-in to ordinary loopback. Requesting
      // true here as well made that option use the same silent OS capture path.
      restrictOwnAudio: !allowSystemLoopback,
    } : false,
    // Without isolation support, safe mode still offers another tab's audio,
    // but does not offer whole-system audio only to discard it after consent.
    // Check returned tracks too: this option remains a picker hint.
    systemAudio: shareAudio && (canExclude || allowSystemLoopback) ? 'include' : 'exclude',
  };
}

function hasIsolatedSystemAudio(audioSettings: OwnAudioSettings, trustedDesktop: boolean): boolean {
  if (audioSettings.restrictOwnAudio === false) return false;
  // Chromium's actual filtered loopback device can be exposed while its
  // experimental restrictOwnAudio setting is omitted. Only the exact device
  // ID is evidence; a translated label or a requested constraint is not.
  // https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/chrome/browser/media/webrtc/webrtc_getdisplaymedia_browsertest.cc
  return audioSettings.restrictOwnAudio === true
    || audioSettings.deviceId === 'loopbackWithoutChrome'
    || trustedDesktop;
}

export function allowScreenAudio(
  audioSettings: OwnAudioSettings,
  displaySurface: string | undefined,
  trustedDesktop = false,
  allowSystemLoopback = false,
): boolean {
  // A tab shares only its own audio. Whole-screen/window loopback can also
  // contain the call, so keep it only when own-audio exclusion is confirmed.
  // Electron 44.9.0 on Windows honors the requested restriction in its capture
  // callback even when Chromium omits the corresponding track setting.
  return displaySurface === 'browser' || hasIsolatedSystemAudio(audioSettings, trustedDesktop) || allowSystemLoopback;
}

export function filterScreenAudio(stream: MediaStream, trustedDesktop = false, allowSystemLoopback = false): {
  removedCount: number;
  retainedCount: number;
  mode: ScreenAudioMode;
  warning?: string;
} {
  let displaySurface: string | undefined;
  try { displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface; }
  catch { /* Unknown sources must not publish unfiltered loopback audio. */ }
  let removedCount = 0;
  let retainedCount = 0;
  let mode: ScreenAudioMode = 'none';
  for (const track of stream.getAudioTracks()) {
    let settings: OwnAudioSettings = {};
    try { settings = track.getSettings(); }
    catch { /* A missing/failed capability query does not prove filtering. */ }
    if (allowScreenAudio(settings, displaySurface, trustedDesktop, allowSystemLoopback)) {
      retainedCount++;
      const trackMode: ScreenAudioMode = displaySurface === 'browser' ? 'tab'
        : hasIsolatedSystemAudio(settings, trustedDesktop && !allowSystemLoopback) ? 'isolated' : 'system';
      // If a future source returns several tracks, report the broadest scope.
      if (mode === 'none' || trackMode === 'system' || (mode === 'tab' && trackMode === 'isolated')) mode = trackMode;
      continue;
    }
    track.stop();
    stream.removeTrack(track);
    removedCount++;
  }
  return {
    removedCount, retainedCount, mode,
    ...(removedCount ? {
      warning: 'Звук трансляции выключен: браузер не подтвердил исключение голосов звонка. Выберите другую вкладку со звуком или явно включите совместимый системный звук в настройках трансляции; он может передавать голоса участников.',
    } : {}),
  };
}

export async function prepareScreenAudio(stream: MediaStream, trustedDesktop = false, allowSystemLoopback = false) {
  // A filtered track is already negotiated; do not reopen its audio source
  // through a redundant constraint after the picker. Compatibility
  // must never be turned back into filtered capture after the picker.
  if (allowSystemLoopback) return filterScreenAudio(stream, trustedDesktop, true);
  // Another browser tab is already an isolated source; reopening it with a
  // whole-browser loopback constraint can suppress the very audio selected.
  try {
    if (stream.getVideoTracks()[0]?.getSettings().displaySurface === 'browser') return filterScreenAudio(stream, trustedDesktop, false);
  } catch { /* Unknown sources still need the checks below. */ }
  for (const track of stream.getAudioTracks()) {
    try {
      if (hasIsolatedSystemAudio(track.getSettings(), trustedDesktop)) continue;
      const capabilities = track.getCapabilities() as MediaTrackCapabilities & { restrictOwnAudio?: boolean[] };
      if (capabilities.restrictOwnAudio?.includes(true)) {
        await track.applyConstraints({ restrictOwnAudio: true } as OwnAudioConstraints);
      }
    } catch { /* Keep the negotiated stream and inspect its settings below. */ }
  }
  return filterScreenAudio(stream, trustedDesktop, allowSystemLoopback);
}
