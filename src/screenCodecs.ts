export type ScreenCodec = 'h264' | 'vp9' | 'vp8';
export type ScreenCodecChoice = 'auto' | ScreenCodec;
export type ScreenContent = 'text' | 'motion';
const PREFERENCE: ScreenCodec[] = ['vp9', 'h264', 'vp8'];
const CONTENT_PREFERENCE: Record<ScreenContent, readonly ScreenCodec[]> = {
  text: ['vp9', 'h264', 'vp8'],
  // An unavailable capability estimate must not force high-resolution gameplay
  // through VP9. Prefer the broadly accelerated H.264 path, then VP8. This is
  // a fallback order, not a claim that any device has a hardware encoder.
  motion: ['h264', 'vp8', 'vp9'],
};

export function availableScreenCodecs(): ScreenCodec[] {
  try {
    const capabilities = RTCRtpSender.getCapabilities?.('video');
    if (capabilities) return PREFERENCE.filter(codec => capabilities.codecs.some(item => item.mimeType.toLowerCase() === `video/${codec}`));
  } catch { /* Older browsers can lack a capability query. Keep the old VP8 fallback. */ }
  return ['vp8'];
}

async function encodingEstimate(codec: ScreenCodec, width: number, height: number, fps: number, bitrate: number): Promise<MediaCapabilitiesEncodingInfo | undefined> {
  if (typeof navigator.mediaCapabilities?.encodingInfo !== 'function') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const estimate = navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: `video/${codec === 'h264' ? 'H264' : codec.toUpperCase()}`,
        width, height, bitrate, framerate: fps,
        ...(codec === 'vp9' ? { scalabilityMode: 'L1T3' } : {}),
      },
    }).catch(() => undefined);
    return await Promise.race([estimate, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 750); })]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function chooseScreenCodec(choice: ScreenCodecChoice, track: MediaStreamTrack, fps: number, bitrate: number, content: ScreenContent = 'text'): Promise<ScreenCodec> {
  const capabilities = availableScreenCodecs();
  const available = CONTENT_PREFERENCE[content].filter(codec => capabilities.includes(codec));
  if (choice !== 'auto') {
    if (!available.includes(choice)) throw new Error('Выбранный кодек недоступен в этом браузере. Выберите «Авто» или другой кодек.');
    return choice;
  }
  const fallback = available[0];
  if (!fallback) throw new Error('Браузер не сообщил о поддерживаемом кодеке видео.');
  const { width, height } = track.getSettings();
  if (!width || !height) return fallback;
  // Query the actual captured dimensions, after getDisplayMedia has already
  // consumed the user's click. This API is an estimate, never a guarantee of
  // hardware acceleration or the frame rate under current system load.
  const estimates = await Promise.all(available.map(async codec => ({ codec, info: await encodingEstimate(codec, width, height, fps, bitrate) })));
  const efficient = estimates.find(item => item.info?.supported === true && item.info.smooth === true && item.info.powerEfficient === true);
  if (efficient) return efficient.codec;
  // Smoothness matters even when the browser cannot mark an encoder as power
  // efficient. Previously a known-slow VP9 estimate still won over smooth
  // H.264 whenever neither reported powerEfficient=true.
  const smooth = estimates.find(item => item.info?.supported === true && item.info.smooth === true);
  if (smooth) return smooth.codec;
  // Prefer an unknown estimate over one that explicitly cannot keep up. If all
  // estimates are negative, capabilities still allow a manual attempt; do not
  // silently change the user's requested resolution, bitrate or frame rate.
  return estimates.find(item => item.info?.supported !== false && item.info?.smooth !== false)?.codec
    ?? estimates.find(item => item.info?.supported !== false)?.codec
    ?? fallback;
}
