type OwnAudioConstraints = MediaTrackConstraints & { restrictOwnAudio: true };
type OwnAudioSettings = MediaTrackSettings & { restrictOwnAudio?: boolean };
type SupportedScreenConstraints = MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean };

export interface ScreenAudioCaptureOptions {
  audio: OwnAudioConstraints | false;
  systemAudio: 'include' | 'exclude';
}

/** Pair with selfBrowserSurface: 'exclude' so captured tab audio cannot be this call. */
export function screenAudioCaptureOptions(
  shareAudio: boolean,
  supportedConstraints: SupportedScreenConstraints,
  trustedDesktop = false,
): ScreenAudioCaptureOptions {
  return {
    audio: shareAudio ? {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      restrictOwnAudio: true,
    } : false,
    // This is a picker hint, not a guarantee. Check the returned tracks too.
    systemAudio: shareAudio && (supportedConstraints.restrictOwnAudio === true || trustedDesktop) ? 'include' : 'exclude',
  };
}

export function allowScreenAudio(
  audioSettings: OwnAudioSettings,
  displaySurface: string | undefined,
  trustedDesktop = false,
): boolean {
  // A tab shares only its own audio. Whole-screen/window loopback can also
  // contain the call, so keep it only when own-audio exclusion is confirmed.
  // Electron 44.9.0 on Windows honors the requested restriction in its capture
  // callback even when Chromium omits the corresponding track setting.
  return displaySurface === 'browser' || audioSettings.restrictOwnAudio === true || trustedDesktop;
}

export function filterScreenAudio(stream: MediaStream, trustedDesktop = false): {
  removedCount: number;
  retainedCount: number;
  warning?: string;
} {
  let displaySurface: string | undefined;
  try { displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface; }
  catch { /* Unknown sources must not publish unfiltered loopback audio. */ }
  let removedCount = 0;
  let retainedCount = 0;
  for (const track of stream.getAudioTracks()) {
    let settings: OwnAudioSettings = {};
    try { settings = track.getSettings(); }
    catch { /* A missing/failed capability query does not prove filtering. */ }
    if (allowScreenAudio(settings, displaySurface, trustedDesktop)) {
      retainedCount++;
      continue;
    }
    track.stop();
    stream.removeTrack(track);
    removedCount++;
  }
  return {
    removedCount, retainedCount,
    ...(removedCount ? {
      warning: 'Звук трансляции отключён: браузер не смог исключить голоса звонка. Чтобы передавать звук, выберите отдельную вкладку браузера.',
    } : {}),
  };
}
