export type ScreenCodec = 'h264' | 'vp9' | 'vp8';
export type ScreenCodecChoice = 'auto' | ScreenCodec;
const PREFERENCE: ScreenCodec[] = ['vp9', 'h264', 'vp8'];

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

export async function chooseScreenCodec(choice: ScreenCodecChoice, track: MediaStreamTrack, fps: number, bitrate: number): Promise<ScreenCodec> {
  const available = availableScreenCodecs();
  if (choice !== 'auto') {
    if (!available.includes(choice)) throw new Error('Выбранный кодек недоступен в этом браузере. Выберите «Авто» или другой кодек.');
    return choice;
  }
  const fallback = available.includes('vp9') ? 'vp9' : available.includes('vp8') ? 'vp8' : available[0];
  if (!fallback) throw new Error('Браузер не сообщил о поддерживаемом кодеке видео.');
  const { width, height } = track.getSettings();
  if (!width || !height) return fallback;
  // Query the actual captured dimensions, after getDisplayMedia has already
  // consumed the user's click. This API is an estimate, never a guarantee of
  // hardware acceleration or the frame rate under current system load.
  const estimates = await Promise.all(available.map(async codec => ({ codec, info: await encodingEstimate(codec, width, height, fps, bitrate) })));
  const efficient = estimates.find(item => item.info?.supported === true && item.info.smooth === true && item.info.powerEfficient === true);
  if (efficient) return efficient.codec;
  // Keep the old VP9 fallback when the query is absent or inconclusive. An
  // explicit negative for it can use a positively supported alternative.
  if (estimates.find(item => item.codec === fallback)?.info?.supported === false) {
    const supported = estimates.find(item => item.info?.supported === true);
    if (supported) return supported.codec;
  }
  return fallback;
}
