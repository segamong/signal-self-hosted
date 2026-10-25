import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteAudioTrack, Room } from 'livekit-client';
import { Volume2, VolumeX } from 'lucide-react';

const STORAGE_PREFIX = 'signal.participant-audio.v1:';
const MAX_SAVED_PARTICIPANTS = 500;
type Volumes = Record<string, number>;
interface ParticipantAudioPreferences { ownerId: string; volumes: Volumes; shareVolumes: Volumes }

function percentage(value: number, maximum = 200): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.round(value))) : 100;
}

function setTrackLevel(track: RemoteAudioTrack, gain: number, mixed: boolean) {
  try { track.setVolume(mixed ? gain : Math.min(1, gain)); }
  catch (error) {
    // AudioContext acquisition is asynchronous at connect/reconnect. If the SDK
    // briefly falls back to its element, keep it valid until startAudio settles.
    if (!(error instanceof DOMException) || error.name !== 'IndexSizeError') throw error;
    track.setVolume(Math.min(1, gain));
  }
}

function cleanVolumes(value: unknown, maximum: number): Volumes {
  const result: Volumes = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [identity, volume] of Object.entries(value).slice(-MAX_SAVED_PARTICIPANTS)) {
    if (identity.length > 0 && identity.length <= 256 && typeof volume === 'number' && Number.isFinite(volume)) {
      result[identity] = percentage(volume, maximum);
    }
  }
  return result;
}

function loadParticipantAudio(ownerId: string): ParticipantAudioPreferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + encodeURIComponent(ownerId)) || '{}');
    if (stored && typeof stored === 'object') {
      const value = stored as { volumes?: unknown; shareVolumes?: unknown };
      return { ownerId, volumes: cleanVolumes(value.volumes, 200), shareVolumes: cleanVolumes(value.shareVolumes, 100) };
    }
  } catch { /* Receiving audio must remain available if storage is unavailable. */ }
  return { ownerId, volumes: Object.create(null), shareVolumes: Object.create(null) };
}

/** Voice and screen audio have independent levels; reconnecting does not reset them. */
export function useParticipantVolumes(ownerId: string) {
  const [preferences, setPreferences] = useState(() => loadParticipantAudio(ownerId));
  useEffect(() => {
    if (preferences.ownerId !== ownerId) {
      setPreferences(loadParticipantAudio(ownerId));
      return;
    }
    try {
      localStorage.setItem(STORAGE_PREFIX + encodeURIComponent(ownerId), JSON.stringify({
        volumes: preferences.volumes, shareVolumes: preferences.shareVolumes,
      }));
    } catch { /* Session controls still work without local storage. */ }
  }, [ownerId, preferences]);

  const changeVolume = useCallback((kind: 'volumes' | 'shareVolumes', identity: string, value: number) => {
    if (!identity || identity.length > 256) return;
    setPreferences(previous => {
      const current = previous.ownerId === ownerId ? previous : loadParticipantAudio(ownerId);
      const next: Volumes = Object.assign(Object.create(null), current[kind], { [identity]: percentage(value, kind === 'volumes' ? 200 : 100) });
      return { ...current, [kind]: cleanVolumes(next, kind === 'volumes' ? 200 : 100) };
    });
  }, [ownerId]);
  const setParticipantVolume = useCallback((identity: string, value: number) => changeVolume('volumes', identity, value), [changeVolume]);
  const setShareVolume = useCallback((identity: string, value: number) => changeVolume('shareVolumes', identity, value), [changeVolume]);
  const current = preferences.ownerId === ownerId ? preferences : loadParticipantAudio(ownerId);
  return { volumes: current.volumes, shareVolumes: current.shareVolumes, setParticipantVolume, setShareVolume };
}

const unlocks = new WeakMap<Room, { users: number; dispose: () => void }>();

function listenForAudioUnlock(room: Room): () => void {
  let entry = unlocks.get(room);
  if (!entry) {
    const unlock = (event: Event) => {
      if (event instanceof KeyboardEvent && event.repeat) return;
      // Room.startAudio resumes the same context used by remote tracks and also
      // preserves the chosen output device; no parallel audio graph is created.
      // Also retry when the SDK has marked playback as available but the OS
      // subsequently suspended the context (for example after device sleep).
      void room.startAudio().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true });
    entry = {
      users: 0,
      dispose: () => {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      },
    };
    unlocks.set(room, entry);
  }
  const shared = entry;
  shared.users++;
  return () => {
    if (--shared.users === 0) {
      shared.dispose();
      unlocks.delete(room);
    }
  };
}

/**
 * Use once per subscribed REMOTE audio publication, with Room({ webAudioMix: true }).
 * LiveKit owns the AudioContext, output switching and one gain node per track.
 * The attached element stays silent: unmuting it would duplicate the WebAudio path.
 * Do not attach a local microphone or local screen audio to this receiver.
 */
export function RemoteCallAudio({ room, track, deafened, volume, outputVolume = 100, onBlocked }: {
  room: Room; track: RemoteAudioTrack; deafened: boolean; volume: number; outputVolume?: number; onBlocked: () => void;
}) {
  const elementRef = useRef<HTMLAudioElement>(null);
  const desired = useRef({ deafened, volume, outputVolume, onBlocked });
  desired.current = { deafened, volume, outputVolume, onBlocked };

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let disposed = false;
    const mixed = !!room.options.webAudioMix;
    const keepElementSilent = () => {
      if (!mixed) return;
      if (!element.muted) element.muted = true;
      if (element.volume !== 0) element.volume = 0;
    };
    const applyLevel = () => {
      const value = desired.current;
      const gain = value.deafened ? 0 : percentage(value.volume) / 100 * percentage(value.outputVolume) / 100;
      // Amplification is a WebAudio gain, never an out-of-range HTML volume.
      // The fallback permits ordinary playback if a caller omits webAudioMix.
      setTrackLevel(track, gain, mixed);
      if (!mixed) element.muted = value.deafened;
      keepElementSilent();
    };
    // Cache the desired gain before attach constructs the SDK graph. In
    // particular, a newly subscribed track must not start briefly at 100% while
    // the listener is deafened or has muted that participant.
    applyLevel();
    track.attach(element);
    applyLevel();
    element.addEventListener('volumechange', keepElementSilent);
    const stopListening = listenForAudioUnlock(room);
    void room.startAudio().then(() => {
      if (disposed) return;
      applyLevel();
      if (!room.canPlaybackAudio && !desired.current.deafened) desired.current.onBlocked();
    }).catch(() => { if (!disposed && !desired.current.deafened) desired.current.onBlocked(); });
    return () => {
      disposed = true;
      stopListening();
      element.removeEventListener('volumechange', keepElementSilent);
      // Reset the SDK's remembered level too: a later graph/element reattach
      // must not inherit an amplified value before our preferences are applied.
      setTrackLevel(track, 0, mixed);
      track.detach(element);
    };
  }, [room, track]);

  useEffect(() => {
    const gain = deafened ? 0 : percentage(volume) / 100 * percentage(outputVolume) / 100;
    setTrackLevel(track, gain, !!room.options.webAudioMix);
    if (!room.options.webAudioMix && elementRef.current) elementRef.current.muted = deafened;
  }, [room, track, deafened, volume, outputVolume]);

  return <audio ref={elementRef} autoPlay muted={!!room.options.webAudioMix || deafened} />;
}

export function ParticipantVolumeControl({ username, value, onChange }: {
  username: string; value: number; onChange: (value: number) => void;
}) {
  const volume = percentage(value);
  return <details className="participant-volume">
    <summary aria-label={`Громкость: ${username}`} title="Громкость собеседника">
      {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </summary>
    <div className="volume-popover"><label>Громкость собеседника <strong>{volume}%</strong>
      <input type="range" min="0" max="200" step="5" value={volume}
        onChange={event => onChange(Number(event.target.value))} aria-label={`Громкость ${username}`} />
    </label></div>
  </details>;
}
