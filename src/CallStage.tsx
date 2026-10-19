import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Room, RoomEvent, ConnectionState, DisconnectReason, Track, LocalVideoTrack, LocalAudioTrack, RemoteAudioTrack, VideoPresets, VideoQuality, BackupCodecPolicy, type LocalTrackPublication, type Participant, type RemoteParticipant, type TrackPublishOptions } from 'livekit-client';
import { Headphones, HeadphoneOff, Mic, MicOff, Video, VideoOff, MonitorUp, MonitorOff, PhoneOff, Settings2, Volume2, VolumeX, Radio, ChevronDown, Maximize2, Minimize2, LoaderCircle, RefreshCw } from 'lucide-react';
import './camera-fullscreen.css';
import ScreenShareFrame from './ScreenShareFrame';
import { toggleElementFullscreen } from './fullscreen';
import { filterScreenAudio, screenAudioCaptureOptions } from './screenAudio';
import { availableScreenCodecs, chooseScreenCodec, type ScreenCodecChoice } from './screenCodecs';

export interface CallStageProps {
  channel: { id: string; name: string };
  user: { id: string; username: string };
  onLeave: () => void;
  onError: (message: string) => void;
  initialPreferences?: CallPreferences;
  onPreferencesChange?: (preferences: CallPreferences) => void;
  onServerRemoved?: () => void;
}

export interface CallPreferences {
  microphone: boolean;
  camera: boolean;
  deafened: boolean;
}

type ScreenProfile = 'source30' | 'source60' | '1440p' | '1080p30' | '1080p60';
const SCREEN_PROFILES = {
  source30: { label: 'Исходное разрешение / 30 fps', fps: 30 },
  source60: { label: 'Исходное разрешение / 60 fps', fps: 60 },
  '1440p': { label: 'До 1440p / 30 fps', width: 2560, height: 1440, fps: 30 },
  '1080p30': { label: 'До 1080p / 30 fps', width: 1920, height: 1080, fps: 30 },
  '1080p60': { label: 'До 1080p / 60 fps', width: 1920, height: 1080, fps: 60 },
} as const;

interface ScreenCaptureSession {
  room: Room;
  stream: MediaStream;
  stopped: boolean;
  tracks: (LocalVideoTrack | LocalAudioTrack)[];
  dispose: () => void;
}

function participantsSharing(room: Room): Participant[] {
  return [room.localParticipant, ...room.remoteParticipants.values()].filter(participant => {
    const publication = participant.getTrackPublication(Track.Source.ScreenShare);
    // A hidden screen has no subscribed videoTrack. Its publication must stay
    // in the switcher so the viewer can subscribe to it again.
    return publication && !publication.isMuted;
  });
}

async function unpublishScreenTracks(room: Room) {
  const tracks = [...room.localParticipant.trackPublications.values()]
    .filter(publication => publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio)
    .flatMap(publication => publication.track ? [publication.track] : []);
  const results = await Promise.allSettled(tracks.map(track => room.localParticipant.unpublishTrack(track, true)));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

const CAMERA_ENCODING: TrackPublishOptions = {
  videoCodec: 'vp8', videoEncoding: { maxBitrate: 3_500_000, maxFramerate: 30 },
  simulcast: true, videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
  degradationPreference: 'maintain-resolution',
};

function messageFor(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') return 'Доступ к устройству отклонён. Разрешите его в настройках браузера и повторите.';
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return 'Устройство не найдено. Подключите микрофон или камеру и повторите.';
    if (error.name === 'NotReadableError') return 'Браузер не смог открыть устройство. Возможно, оно занято другим приложением.';
    // Connection errors may include the signaling URL and its access_token.
    // Keep those diagnostics out of toasts and the visible connection panel.
    if (error.name === 'ConnectionError' || /(?:https?|wss?):\/\/|access[_-]?token|\btoken\b|\bapi[_-]?key\b|authorization|\bbearer\b|\bjwt\b|\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i.test(error.message)) return 'Не удалось выполнить действие на голосовом сервере. Проверьте соединение и повторите попытку.';
    return error.message.slice(0, 400) || 'Не удалось выполнить действие. Повторите попытку.';
  }
  return 'Не удалось выполнить действие. Повторите попытку.';
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
}

function colorFor(identity: string) {
  let value = 0;
  for (const character of identity) value = ((value << 5) - value + character.charCodeAt(0)) | 0;
  return ['#7e68e8', '#3688bc', '#aa687e', '#53896f', '#a57e4c', '#6375bb'][Math.abs(value) % 6];
}

function MediaVideo({ track, local, screen }: { track: Track; local: boolean; screen: boolean }) {
  const elementRef = useRef<HTMLVideoElement>(null);
  const [actual, setActual] = useState('');
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.muted = true;
    track.attach(element);
    if (screen) return () => { track.detach(element); };
    const update = () => {
      const settings = track.mediaStreamTrack.getSettings();
      const width = element.videoWidth || settings.width;
      const height = element.videoHeight || settings.height;
      const fps = settings.frameRate;
      setActual(width && height ? `${width} × ${height}${local && fps ? ` · цель до ${Math.round(fps)} кадр/с` : ''}` : 'Получение видео…');
    };
    element.addEventListener('loadedmetadata', update);
    element.addEventListener('resize', update);
    update();
    const timer = window.setInterval(update, 1500);
    return () => {
      window.clearInterval(timer);
      element.removeEventListener('loadedmetadata', update);
      element.removeEventListener('resize', update);
      track.detach(element);
    };
  }, [track, local, screen]);
  return <>
    <video ref={elementRef} autoPlay playsInline muted className={`${screen ? 'screen-video' : 'camera-video'}${local && !screen ? ' mirrored' : ''}`} />
    {!screen && actual && <span className="video-quality" title="Размер отображаемого кадра. Целевая частота захвата не является измеренной частотой передачи.">{actual}</span>}
  </>;
}

function RemoteAudio({ track, deafened, volume, onBlocked }: { track: RemoteAudioTrack; deafened: boolean; volume: number; onBlocked: () => void }) {
  const elementRef = useRef<HTMLAudioElement>(null);
  const preferences = useRef({ deafened, volume });
  preferences.current = { deafened, volume };
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let disposed = false;
    const applyPreferences = () => {
      const desired = preferences.current;
      const level = desired.deafened ? 0 : Math.min(1, Math.max(0, desired.volume / 100));
      if (element.muted !== desired.deafened) element.muted = desired.deafened;
      if (element.volume !== level) element.volume = level;
    };
    track.attach(element);
    applyPreferences();
    // LiveKit startAudio unmutes attached elements when a local capture begins.
    // Preserve the user's deafen preference across that browser unlock step.
    element.addEventListener('volumechange', applyPreferences);
    void element.play().catch(() => { if (!disposed && !preferences.current.deafened) onBlocked(); });
    return () => { disposed = true; element.removeEventListener('volumechange', applyPreferences); track.detach(element); };
  }, [track, onBlocked]);
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.muted = deafened;
    const level = deafened ? 0 : Math.min(1, Math.max(0, volume / 100));
    track.setVolume(level);
    element.volume = level;
  }, [deafened, volume, track]);
  return <audio ref={elementRef} autoPlay muted={deafened} />;
}

function ParticipantTile({ participant, username, local, volume, onVolume, onError, compact = false }: {
  participant: Participant; username: string; local: boolean; volume: number; onVolume: (value: number) => void; onError: (message: string) => void; compact?: boolean;
}) {
  const publication = participant.getTrackPublication(Track.Source.Camera);
  const track = !publication?.isMuted ? publication?.videoTrack : undefined;
  const name = username;
  const tileRef = useRef<HTMLElement>(null);
  const changingFullscreen = useRef(false);
  const availableTrack = useRef(track);
  availableTrack.current = track;
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const tile = tileRef.current;
    const syncFullscreen = () => {
      const active = document.fullscreenElement === tile;
      setFullscreen(active);
      if (active && !availableTrack.current) void document.exitFullscreen().catch(() => {});
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      if (tile && document.fullscreenElement === tile) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!track && tileRef.current && document.fullscreenElement === tileRef.current) void document.exitFullscreen().catch(() => {});
  }, [track]);
  const toggleFullscreen = () => {
    const tile = tileRef.current;
    if (!tile || !track || changingFullscreen.current) return;
    changingFullscreen.current = true;
    try {
      const operation = toggleElementFullscreen(tile);
      void operation.catch(() => onError('Не удалось развернуть видео на весь экран. Повторите нажатие.'))
        .finally(() => { changingFullscreen.current = false; });
    } catch {
      changingFullscreen.current = false;
      onError('Полноэкранное видео недоступно в этом приложении.');
    }
  };
  return <article ref={tileRef} className={`participant-tile${participant.isSpeaking ? ' speaking' : ''}${compact ? ' compact' : ''}${track ? ' has-video' : ''}`}
    onDoubleClick={event => { if (event.target instanceof HTMLVideoElement) toggleFullscreen(); }}>
    {track ? <MediaVideo track={track} local={local} screen={false} /> : <div className="participant-avatar" style={{ background: colorFor(participant.identity) }}>{initials(name)}</div>}
    {track && <button className="participant-fullscreen-toggle" type="button" onClick={toggleFullscreen}
      aria-label={fullscreen ? `Свернуть видео: ${name}` : `Развернуть камеру на весь экран: ${name}`}
      title={fullscreen ? 'Выйти из полного экрана · Esc' : 'Камера на весь экран · двойной щелчок'} aria-pressed={fullscreen}>
      {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
    </button>}
    {fullscreen && <span className="camera-fullscreen-hint">Esc — свернуть видео</span>}
    <div className="participant-caption"><span>{name}{local && <small> · вы</small>}</span>
      <span className="participant-caption-icons">{participant.isMicrophoneEnabled ? <Mic size={14} /> : <MicOff size={14} />}</span>
    </div>
    {!local && <details className="participant-volume">
      <summary aria-label={`Громкость: ${name}`} title="Громкость участника">{volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}</summary>
      <div className="volume-popover"><label>Громкость <strong>{volume}%</strong><input type="range" min="0" max="100" step="5" value={volume} onChange={event => onVolume(Number(event.target.value))} aria-label={`Громкость ${name}`} /></label></div>
    </details>}
    {participant.isSpeaking && <span className="speaking-indicator" aria-label="Говорит"><i /><i /><i /></span>}
  </article>;
}

export default function CallStage({ channel, user, onLeave, onError, initialPreferences, onPreferencesChange, onServerRemoved }: CallStageProps) {
  const roomRef = useRef<Room | null>(null);
  const screenCaptureRef = useRef<ScreenCaptureSession | null>(null);
  const callbacks = useRef({ onError, onLeave, onPreferencesChange, onServerRemoved });
  callbacks.current = { onError, onLeave, onPreferencesChange, onServerRemoved };
  const preferencesRef = useRef<CallPreferences>({ microphone: initialPreferences?.microphone === true, camera: initialPreferences?.camera === true, deafened: initialPreferences?.deafened === true });
  const lastReportedPreferences = useRef<CallPreferences | null>(null);
  const restoredRoomRef = useRef<Room | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<ConnectionState>(ConnectionState.Connecting);
  const [connectionError, setConnectionError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [deafened, setDeafened] = useState(preferencesRef.current.deafened);
  const deafenedRef = useRef(deafened);
  deafenedRef.current = deafened;
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [devicesRequested, setDevicesRequested] = useState(false);
  const [deviceSelection, setDeviceSelection] = useState({ audioinput: 'default', videoinput: 'default', audiooutput: 'default' });
  const [screenProfile, setScreenProfile] = useState<ScreenProfile>('source30');
  const [screenBitrate, setScreenBitrate] = useState(24_000_000);
  const [screenContent, setScreenContent] = useState<'text' | 'motion'>('text');
  const [screenCodec, setScreenCodec] = useState<ScreenCodecChoice>('auto');
  const [screenCodecs] = useState(availableScreenCodecs);
  const [cameraQuality, setCameraQuality] = useState<'high' | 'medium'>('high');
  const cameraQualityRef = useRef(cameraQuality);
  cameraQualityRef.current = cameraQuality;
  const [shareAudio, setShareAudio] = useState(true);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [focusedShare, setFocusedShare] = useState<string | null>(null);
  const focusedShareRef = useRef<string | null>(null);
  const [memberDirectory, setMemberDirectory] = useState<{ channelId: string; usernames: Map<string, string> }>({ channelId: '', usernames: new Map() });
  const markAudioBlocked = useCallback(() => setAudioBlocked(true), []);
  const releaseScreenCapture = useCallback((owner: Room, expected?: ScreenCaptureSession) => {
    const capture = expected || screenCaptureRef.current;
    if (!capture || capture.room !== owner) return;
    if (screenCaptureRef.current === capture) screenCaptureRef.current = null;
    capture.dispose();
  }, []);

  const updateScreenSubscriptions = useCallback((current: Room) => {
    if (roomRef.current !== current) return;
    const shares = participantsSharing(current);
    const selected = shares.find(participant => participant.identity === focusedShareRef.current) || shares[0];
    const selectedIdentity = selected?.identity ?? null;
    if (focusedShareRef.current !== selectedIdentity) {
      focusedShareRef.current = selectedIdentity;
      setFocusedShare(selectedIdentity);
    }
    for (const participant of current.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.source !== Track.Source.ScreenShare && publication.source !== Track.Source.ScreenShareAudio) continue;
        const wanted = participant.identity === selectedIdentity;
        if (publication.isDesired !== wanted) publication.setSubscribed(wanted);
        if (wanted && publication.source === Track.Source.ScreenShare) publication.setVideoQuality(VideoQuality.HIGH);
      }
    }
  }, []);

  const focusShare = (identity: string) => {
    focusedShareRef.current = identity;
    setFocusedShare(identity);
    const current = roomRef.current;
    if (current) updateScreenSubscriptions(current);
  };

  const reportPreferences = useCallback((owner?: Room, changes?: Partial<CallPreferences>) => {
    const current = roomRef.current;
    if (!current || current.state !== ConnectionState.Connected || (owner && owner !== current) || restoredRoomRef.current !== current) return;
    // Store the user's choices, not temporary SFU mute / permission state.
    // Only explicit successful controls supply microphone / camera changes.
    const next: CallPreferences = { ...preferencesRef.current, ...changes, deafened: deafenedRef.current };
    preferencesRef.current = next;
    const previous = lastReportedPreferences.current;
    if (previous && previous.microphone === next.microphone && previous.camera === next.camera && previous.deafened === next.deafened) return;
    lastReportedPreferences.current = next;
    callbacks.current.onPreferencesChange?.({ ...next });
  }, []);

  useEffect(() => { reportPreferences(); }, [deafened, reportPreferences]);

  useEffect(() => {
    let cancelled = false;
    let requestNumber = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setMemberDirectory({ channelId: channel.id, usernames: new Map() });
    const refreshMembers = async () => {
      const request = ++requestNumber;
      try {
        const result = await api<{ members: { id: string; username: string }[] }>(`/channels/${encodeURIComponent(channel.id)}/members`);
        if (cancelled || request !== requestNumber) return;
        const usernames = new Map<string, string>();
        for (const member of result.members) {
          if (typeof member.id === 'string' && typeof member.username === 'string' && /^[A-Za-z0-9_-]{3,32}$/.test(member.username)) usernames.set(member.id, member.username);
        }
        setMemberDirectory({ channelId: channel.id, usernames });
      } catch {
        // Never fall back to participant.name or metadata: existing SFU sessions
        // can still contain the old display name. Retry on the next room event.
      }
    };
    const queueRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refreshMembers(); }, 250);
    };
    void refreshMembers();
    room?.on(RoomEvent.ParticipantConnected, queueRefresh);
    room?.on(RoomEvent.Reconnected, queueRefresh);
    return () => {
      cancelled = true;
      clearTimeout(refreshTimer);
      room?.off(RoomEvent.ParticipantConnected, queueRefresh);
      room?.off(RoomEvent.Reconnected, queueRefresh);
    };
  }, [channel.id, user.id, room]);

  const usernameFor = (participant: Participant) => participant.identity === user.id
    ? user.username
    : (memberDirectory.channelId === channel.id ? memberDirectory.usernames.get(participant.identity) : undefined) || 'Участник';

  useEffect(() => {
    let cancelled = false;
    let connectedOnce = false;
    const controller = new AbortController();
    const nextRoom = new Room({
      adaptiveStream: false,
      dynacast: true,
      disconnectOnPageLeave: true,
      videoCaptureDefaults: { resolution: { width: 1920, height: 1080, frameRate: 30 } },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      publishDefaults: { ...CAMERA_ENCODING, audioPreset: { maxBitrate: 64_000 }, dtx: true, red: true, stopMicTrackOnMute: true },
    });
    roomRef.current = nextRoom;
    focusedShareRef.current = null;
    setFocusedShare(null);
    restoredRoomRef.current = null;
    setRoom(null);
    setState(ConnectionState.Connecting);
    setConnectionError('');
    setBusy(null);
    const sync = () => {
      if (cancelled) return;
      updateScreenSubscriptions(nextRoom);
      refresh(value => value + 1);
      setState(nextRoom.state);
    };
    const playback = () => { if (!cancelled) setAudioBlocked(!nextRoom.canPlaybackAudio); };
    const requestVideoQuality = () => {
      for (const participant of nextRoom.remoteParticipants.values()) {
        for (const publication of participant.videoTrackPublications.values()) {
          if (publication.source === Track.Source.Camera) publication.setVideoQuality(cameraQualityRef.current === 'medium' ? VideoQuality.MEDIUM : VideoQuality.HIGH);
        }
      }
    };
    const deviceError = (error: Error) => { if (!cancelled) callbacks.current.onError(messageFor(error)); };
    const events = [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged, RoomEvent.ParticipantNameChanged, RoomEvent.ConnectionQualityChanged,
      RoomEvent.ConnectionStateChanged, RoomEvent.Reconnected, RoomEvent.Reconnecting] as const;
    for (const event of events) nextRoom.on(event, sync);
    nextRoom.on(RoomEvent.AudioPlaybackStatusChanged, playback);
    nextRoom.on(RoomEvent.TrackSubscribed, requestVideoQuality);
    nextRoom.on(RoomEvent.TrackPublished, requestVideoQuality);
    nextRoom.on(RoomEvent.MediaDevicesError, deviceError);
    const localUnpublished = (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.ScreenShare) return;
      // SDK reconnect/republish uses unpublishTrack(track, false). Keep the
      // live source in that case so the next publication can reuse it.
      if (publication.track?.mediaStreamTrack.readyState === 'live' && nextRoom.state !== ConnectionState.Disconnected) return;
      releaseScreenCapture(nextRoom);
      // The browser's Stop sharing command can end the video before audio.
      // Remove the remaining screen audio as well, without touching the mic.
      queueMicrotask(() => { void unpublishScreenTracks(nextRoom).catch(() => {}); });
    };
    nextRoom.on(RoomEvent.LocalTrackUnpublished, localUnpublished);
    const disconnected = (reason?: DisconnectReason) => {
      if (cancelled || roomRef.current !== nextRoom) return;
      if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
        releaseScreenCapture(nextRoom);
        restoredRoomRef.current = null;
        callbacks.current.onServerRemoved?.();
        callbacks.current.onLeave();
        return;
      }
      if (!connectedOnce) return;
      releaseScreenCapture(nextRoom);
      sync();
      setConnectionError('Соединение с голосовым каналом завершено. Можно подключиться снова.');
    };
    nextRoom.on(RoomEvent.Disconnected, disconnected);

    void (async () => {
      try {
        const data = await api<{url:string;token:string}>(`/channels/${encodeURIComponent(channel.id)}/join`, {});
        if (typeof data.url !== 'string' || typeof data.token !== 'string') throw new Error('Сервер не вернул параметры подключения');
        if (cancelled) return;
        await nextRoom.connect(data.url, data.token, { autoSubscribe: true });
        if (cancelled) { await nextRoom.disconnect(true); return; }
        connectedOnce = true;
        setRoom(nextRoom);
        setBusy('restoring');
        requestVideoQuality();
        sync();
        playback();
        const desired = { ...preferencesRef.current };
        // Camera and microphone may resume only from the user's saved choices.
        // A capture permission failure keeps the channel connected and that
        // device off. Screen capture is deliberately never restored here.
        if (desired.microphone) {
          try { await nextRoom.localParticipant.setMicrophoneEnabled(true); }
          catch (error) { if (!cancelled && roomRef.current === nextRoom) callbacks.current.onError(`Не удалось восстановить микрофон: ${messageFor(error)}`); }
        }
        if (cancelled || roomRef.current !== nextRoom || nextRoom.state !== ConnectionState.Connected) { await nextRoom.disconnect(true); return; }
        if (desired.camera) {
          try { await nextRoom.localParticipant.setCameraEnabled(true, { resolution: { width: 1920, height: 1080, frameRate: 30 } }, CAMERA_ENCODING); }
          catch (error) { if (!cancelled && roomRef.current === nextRoom) callbacks.current.onError(`Не удалось восстановить камеру: ${messageFor(error)}`); }
        }
        if (cancelled || roomRef.current !== nextRoom || nextRoom.state !== ConnectionState.Connected) { await nextRoom.disconnect(true); return; }
        restoredRoomRef.current = nextRoom;
        setBusy(null);
        reportPreferences(nextRoom);
        sync();
        playback();
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const message = messageFor(error);
        setConnectionError(message);
        setState(ConnectionState.Disconnected);
        callbacks.current.onError(message);
        await nextRoom.disconnect(true);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      for (const event of events) nextRoom.off(event, sync);
      nextRoom.off(RoomEvent.AudioPlaybackStatusChanged, playback);
      nextRoom.off(RoomEvent.TrackSubscribed, requestVideoQuality);
      nextRoom.off(RoomEvent.TrackPublished, requestVideoQuality);
      nextRoom.off(RoomEvent.MediaDevicesError, deviceError);
      nextRoom.off(RoomEvent.LocalTrackUnpublished, localUnpublished);
      nextRoom.off(RoomEvent.Disconnected, disconnected);
      if (restoredRoomRef.current === nextRoom) restoredRoomRef.current = null;
      if (roomRef.current === nextRoom) roomRef.current = null;
      releaseScreenCapture(nextRoom);
      // disconnect(true) stops all local capture tracks, including screen audio.
      void nextRoom.disconnect(true);
    };
  }, [channel.id, user.id, attempt, releaseScreenCapture, reportPreferences, updateScreenSubscriptions]);

  useEffect(() => {
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.videoTrackPublications.values()) {
        if (publication.source === Track.Source.Camera) publication.setVideoQuality(cameraQuality === 'medium' ? VideoQuality.MEDIUM : VideoQuality.HIGH);
      }
    }
  }, [room, cameraQuality]);

  useEffect(() => {
    if (room) updateScreenSubscriptions(room);
  }, [room, focusedShare, updateScreenSubscriptions]);

  const listDevices = async () => {
    const requestingRoom = roomRef.current;
    setDevicesRequested(true);
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('Устройства доступны в браузере через HTTPS или localhost');
      const available = await navigator.mediaDevices.enumerateDevices();
      if (roomRef.current !== requestingRoom) return;
      setDevices(available);
      const current = roomRef.current;
      if (current) setDeviceSelection({
        audioinput: current.getActiveDevice('audioinput') || 'default',
        videoinput: current.getActiveDevice('videoinput') || 'default',
        audiooutput: current.getActiveDevice('audiooutput') || 'default',
      });
    } catch (error) { callbacks.current.onError(messageFor(error)); }
  };

  const act = (key: string, operation: (current: Room) => Promise<unknown>) => {
    const current = roomRef.current;
    if (!current || current.state !== ConnectionState.Connected || busy) return;
    setBusy(key);
    // Invoke immediately so capture APIs retain the browser's click activation.
    void operation(current).catch(error => {
      if (roomRef.current === current) callbacks.current.onError(messageFor(error));
    }).finally(() => {
      if (roomRef.current === current) { setBusy(null); reportPreferences(current); refresh(value => value + 1); }
    });
  };

  const changeDevice = (kind: MediaDeviceKind, deviceId: string) => act(`device-${kind}`, async current => {
    if (kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype)) throw new Error('Этот браузер не поддерживает выбор устройства вывода звука');
    const changed = await current.switchActiveDevice(kind, deviceId);
    if (!changed) throw new Error('Не удалось переключить устройство');
    if (roomRef.current === current) setDeviceSelection(previous => ({ ...previous, [kind]: deviceId }));
  });

  const toggleMicrophone = () => act('microphone', async current => {
    const enabled = !current.localParticipant.isMicrophoneEnabled;
    await current.localParticipant.setMicrophoneEnabled(enabled);
    if (roomRef.current !== current) { await current.disconnect(true); return; }
    reportPreferences(current, { microphone: enabled });
    if (devicesRequested) await listDevices();
  });

  const toggleMicrophoneRef = useRef(toggleMicrophone);
  toggleMicrophoneRef.current = toggleMicrophone;
  useEffect(() => window.signalDesktop?.subscribeEvents(event => {
    if (event.type === 'toggle-microphone') toggleMicrophoneRef.current();
  }), []);

  const toggleCamera = () => act('camera', async current => {
    const enabled = !current.localParticipant.isCameraEnabled;
    await current.localParticipant.setCameraEnabled(enabled,
      { resolution: { width: 1920, height: 1080, frameRate: 30 } }, CAMERA_ENCODING);
    if (roomRef.current !== current) { await current.disconnect(true); return; }
    reportPreferences(current, { camera: enabled });
    if (devicesRequested) await listDevices();
  });

  const toggleScreen = () => act('screen', async current => {
    if (current.localParticipant.isScreenShareEnabled || screenCaptureRef.current?.room === current) {
      releaseScreenCapture(current);
      await unpublishScreenTracks(current);
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Этот браузер не поддерживает трансляцию экрана. Откройте приложение в Chrome или другом поддерживаемом браузере через HTTPS.');
    const profile = SCREEN_PROFILES[screenProfile];
    const videoConstraints: MediaTrackConstraints = { frameRate: { ideal: profile.fps, max: profile.fps } };
    if ('width' in profile) {
      videoConstraints.width = { max: profile.width };
      videoConstraints.height = { max: profile.height };
    }
    const trustedDesktop = Boolean(window.signalDesktop);
    const displayOptions: DisplayMediaStreamOptions & { systemAudio: 'include' | 'exclude'; selfBrowserSurface: 'exclude'; surfaceSwitching: 'include' } = {
      video: videoConstraints,
      ...screenAudioCaptureOptions(shareAudio, navigator.mediaDevices.getSupportedConstraints(), trustedDesktop),
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    };
    // Native modes intentionally omit width/height and bypass the SDK's
    // default 1080p capture limit. The browser still asks what to share.
    const stream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
    if (roomRef.current !== current || current.state !== ConnectionState.Connected) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const { warning } = filterScreenAudio(stream, trustedDesktop);
    if (warning) callbacks.current.onError(warning);
    const capture: ScreenCaptureSession = { room: current, stream, stopped: false, tracks: [], dispose: () => {} };
    const ended = () => {
      releaseScreenCapture(current, capture);
      void unpublishScreenTracks(current).catch(error => {
        if (roomRef.current === current && current.state === ConnectionState.Connected) callbacks.current.onError(messageFor(error));
      });
    };
    capture.dispose = () => {
      if (capture.stopped) return;
      capture.stopped = true;
      stream.getVideoTracks().forEach(track => track.removeEventListener('ended', ended));
      capture.tracks.forEach(track => track.stop());
      stream.getTracks().forEach(track => track.stop());
    };
    screenCaptureRef.current = capture;
    try {
      const mediaTrack = stream.getVideoTracks()[0];
      if (!mediaTrack) throw new Error('Браузер не вернул видеопоток экрана');
      mediaTrack.addEventListener('ended', ended, { once: true });
      mediaTrack.contentHint = screenContent;
      if ('width' in profile) await mediaTrack.applyConstraints(videoConstraints);
      if (capture.stopped || roomRef.current !== current) { releaseScreenCapture(current, capture); return; }
      const videoTrack = new LocalVideoTrack(mediaTrack, undefined, true);
      videoTrack.source = Track.Source.ScreenShare;
      capture.tracks.push(videoTrack);
      const codec = await chooseScreenCodec(screenCodec, mediaTrack, profile.fps, screenBitrate);
      if (capture.stopped || roomRef.current !== current || current.state !== ConnectionState.Connected) { releaseScreenCapture(current, capture); return; }
      const vp9 = codec === 'vp9';
      const encoding = { maxBitrate: screenBitrate, maxFramerate: profile.fps };
      const screenStream = `screen-${stream.id}`;
      await current.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare, stream: screenStream,
        videoCodec: codec,
        backupCodec: vp9 && screenCodecs.includes('vp8') ? { codec: 'vp8', encoding } : false,
        backupCodecPolicy: BackupCodecPolicy.PREFER_REGRESSION,
        scalabilityMode: vp9 ? 'L1T3' : undefined,
        videoEncoding: encoding, screenShareEncoding: encoding,
        simulcast: false, videoSimulcastLayers: [], screenShareSimulcastLayers: [],
        degradationPreference: 'maintain-resolution',
      });
      if (capture.stopped || roomRef.current !== current) {
        releaseScreenCapture(current, capture);
        await unpublishScreenTracks(current);
        return;
      }
      for (const mediaAudio of stream.getAudioTracks()) {
        if (capture.stopped) break;
        const audioTrack = new LocalAudioTrack(mediaAudio, undefined, true);
        audioTrack.source = Track.Source.ScreenShareAudio;
        capture.tracks.push(audioTrack);
        await current.localParticipant.publishTrack(audioTrack, {
          source: Track.Source.ScreenShareAudio, stream: screenStream,
          audioPreset: { maxBitrate: 128_000 }, forceStereo: true, dtx: false, red: true,
        });
      }
      if (capture.stopped || roomRef.current !== current) {
        releaseScreenCapture(current, capture);
        await unpublishScreenTracks(current);
        return;
      }
      focusShare(current.localParticipant.identity);
    } catch (error) {
      releaseScreenCapture(current, capture);
      await unpublishScreenTracks(current).catch(() => {});
      throw error;
    }
  });

  const leave = () => {
    const current = roomRef.current;
    roomRef.current = null;
    if (current) releaseScreenCapture(current);
    if (current) void current.disconnect(true);
    callbacks.current.onLeave();
  };

  const participants: Participant[] = room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
  const shares = room ? participantsSharing(room) : [];
  const shareParticipant = shares.find(participant => participant.identity === focusedShare) || shares[0];
  const shareTrack = shareParticipant?.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
  const connected = state === ConnectionState.Connected && !!room;
  const microphoneOn = room?.localParticipant.isMicrophoneEnabled ?? false;
  const cameraOn = room?.localParticipant.isCameraEnabled ?? false;
  const sharing = room?.localParticipant.isScreenShareEnabled ?? false;
  const remote = participants.filter((participant): participant is RemoteParticipant => !participant.isLocal);
  const statusLabel = connected ? 'Вы в голосовом канале' : state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting ? 'Восстанавливаем связь…' : connectionError ? 'Нет соединения' : 'Подключаемся…';

  return <section className={`call-stage${shareParticipant ? ' has-share' : ''}`} aria-label={`Голосовой канал ${channel.name}`}>
    <div className="call-heading"><div><span className={`call-connection${connected ? ' connected' : ''}`}><Radio size={14} />{statusLabel}</span><h2>{channel.name}</h2></div>
      <span className="call-count">{participants.length} / 10 участников</span></div>

    {!connected && <div className="call-status" role="status">
      {connectionError ? <><Radio size={30} /><h3>Не удалось подключиться</h3><p>{connectionError}</p><button className="button primary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />Повторить подключение</button></> : <><LoaderCircle className="spin" size={30} /><h3>{statusLabel}</h3><p>Микрофон и камера включаются кнопками ниже.</p></>}
    </div>}

    {room && <>
      {audioBlocked && !deafened && <div className="audio-unlock" role="status"><Volume2 size={18} /><span>Браузер ожидает разрешения на воспроизведение звука.</span><button onClick={() => act('audio', async current => { await current.startAudio(); if (roomRef.current === current) setAudioBlocked(!current.canPlaybackAudio); })}>Включить звук</button></div>}
      <div className="remote-audio" aria-hidden="true">{remote.flatMap(participant => [...participant.audioTrackPublications.values()].map(publication => publication.audioTrack instanceof RemoteAudioTrack && (publication.source !== Track.Source.ScreenShareAudio || participant.identity === shareParticipant?.identity) ? <RemoteAudio key={publication.trackSid} track={publication.audioTrack} deafened={deafened} volume={volumes[participant.identity] ?? 100} onBlocked={markAudioBlocked} /> : null))}</div>
      {shareParticipant && <ScreenShareFrame username={usernameFor(shareParticipant)} onError={message => callbacks.current.onError(message)}>
        <div className="share-video-wrap">{shareTrack ? <MediaVideo track={shareTrack} local={shareParticipant.isLocal} screen /> : <div className="share-loading"><LoaderCircle className="spin" size={24} /><span>Подключаем выбранную демонстрацию…</span></div>}</div>
        {shares.length > 1 && <div className="share-switcher">{shares.map(participant => <button key={participant.identity} className={participant === shareParticipant ? 'active' : ''} aria-pressed={participant === shareParticipant} onClick={() => focusShare(participant.identity)}>{usernameFor(participant)}</button>)}</div>}
      </ScreenShareFrame>}
      <div className={`participant-grid${shareParticipant ? ' thumbnails' : ''}`}>{participants.map(participant => <ParticipantTile key={participant.identity} participant={participant} username={usernameFor(participant)} local={participant.isLocal} compact={!!shareParticipant} volume={volumes[participant.identity] ?? 100} onVolume={value => setVolumes(previous => ({ ...previous, [participant.identity]: value }))} onError={message => callbacks.current.onError(message)} />)}</div>
      {participants.length === 1 && !shareParticipant && <div className="call-alone"><span>Здесь пока тихо</span><p>Вы уже в канале. Пригласите друзей и начните разговор.</p></div>}
    </>}

    {settingsOpen && <div className="call-settings"><div className="settings-heading"><h3>Звук и видео</h3><button className="text-button" onClick={() => void listDevices()}><RefreshCw size={14} />Обновить устройства</button></div>
      <div className="device-grid">{(['audioinput', 'audiooutput', 'videoinput'] as const).map(kind => <label key={kind}>{kind === 'audioinput' ? 'Микрофон' : kind === 'audiooutput' ? 'Наушники / динамики' : 'Камера'}<select value={deviceSelection[kind]} disabled={!connected || !!busy || (kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype))} onChange={event => changeDevice(kind, event.target.value)}><option value="default">По умолчанию</option>{devices.filter(device => device.kind === kind && device.deviceId !== 'default' && device.deviceId !== '').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${kind === 'videoinput' ? 'Камера' : 'Устройство'} ${index + 1}`}</option>)}</select></label>)}</div>
      <p className="settings-hint">Названия устройств появятся после разрешения браузера. Выбор динамиков доступен в поддерживаемых браузерах.</p>
      <label>Качество входящего видео<select value={cameraQuality} onChange={event => setCameraQuality(event.target.value as 'high' | 'medium')}><option value="high">Высокое · до 1080p</option><option value="medium">Экономия · до 360p</option></select></label>
      <p className="settings-hint">Высокое качество требует достаточной скорости сети. Фактическое разрешение видно на видео; при перегрузке сети оно может снижаться.</p>
      <h3>Трансляция экрана</h3>
      <div className="share-settings"><label>Разрешение и частота<select value={screenProfile} disabled={sharing || busy === 'screen'} onChange={event => setScreenProfile(event.target.value as ScreenProfile)}>{Object.entries(SCREEN_PROFILES).map(([value, profile]) => <option key={value} value={value}>{profile.label}</option>)}</select></label>
        <label>Максимальный битрейт<select value={screenBitrate} disabled={sharing || busy === 'screen'} onChange={event => setScreenBitrate(Number(event.target.value))}><option value={12_000_000}>12 Мбит/с</option><option value={24_000_000}>24 Мбит/с · высокое качество</option><option value={40_000_000}>40 Мбит/с · максимум</option></select></label>
        <label>Что показываете<select value={screenContent} disabled={sharing || busy === 'screen'} onChange={event => setScreenContent(event.target.value as 'text' | 'motion')}><option value="text">Текст и приложения · чёткость</option><option value="motion">Игры и видео · движение</option></select></label>
        <label>Кодек экрана<select value={screenCodec} disabled={sharing || busy === 'screen'} onChange={event => setScreenCodec(event.target.value as ScreenCodecChoice)}><option value="auto">Авто · оценка браузера</option><option value="h264" disabled={!screenCodecs.includes('h264')}>H.264{!screenCodecs.includes('h264') ? ' · недоступен' : ''}</option><option value="vp9" disabled={!screenCodecs.includes('vp9')}>VP9{!screenCodecs.includes('vp9') ? ' · недоступен' : ''}</option><option value="vp8" disabled={!screenCodecs.includes('vp8')}>VP8{!screenCodecs.includes('vp8') ? ' · недоступен' : ''}</option></select></label>
        <label className="checkbox-label"><input type="checkbox" checked={shareAudio} disabled={sharing || busy === 'screen'} onChange={event => setShareAudio(event.target.checked)} />Передавать звук вкладки / системы</label></div>
      <p className="settings-hint">Исходное разрешение; WebRTC использует сжатие. Фактическое качество зависит от сети. Для смены параметров остановите трансляцию.</p>
      <p className="settings-hint">Для звука включите его передачу в окне выбора экрана или вкладки браузера.</p>
      <p className="settings-hint">«Авто» учитывает оценку кодирования браузером. При нехватке процессора или полосы частота кадров может падать. Получаем только видео и звук выбранной демонстрации.</p>
    </div>}

    <div className="call-toolbar"><div className="toolbar-main">
      <button className={`call-control${microphoneOn ? '' : ' off'}`} disabled={!connected || !!busy} onClick={toggleMicrophone} title={microphoneOn ? 'Выключить микрофон' : 'Включить микрофон'} aria-label={microphoneOn ? 'Выключить микрофон' : 'Включить микрофон'} aria-pressed={microphoneOn}>{busy === 'microphone' ? <LoaderCircle className="spin" size={21} /> : microphoneOn ? <Mic size={21} /> : <MicOff size={21} />}<span>Микрофон</span></button>
      <button className={`call-control${deafened ? ' off' : ''}`} disabled={!connected} onClick={() => { setDeafened(value => !value); if (deafened && roomRef.current) void roomRef.current.startAudio().catch(markAudioBlocked); }} title={deafened ? 'Включить звук' : 'Отключить входящий звук'} aria-label={deafened ? 'Включить входящий звук' : 'Отключить входящий звук'} aria-pressed={!deafened}>{deafened ? <HeadphoneOff size={21} /> : <Headphones size={21} />}<span>Наушники</span></button>
      <span className="toolbar-divider" />
      <button className={`call-control${cameraOn ? ' active' : ''}`} disabled={!connected || !!busy} onClick={toggleCamera} aria-label={cameraOn ? 'Выключить камеру' : 'Включить камеру'} aria-pressed={cameraOn}>{busy === 'camera' ? <LoaderCircle className="spin" size={21} /> : cameraOn ? <Video size={21} /> : <VideoOff size={21} />}<span>Камера</span></button>
      <button className={`call-control${sharing ? ' active' : ''}`} disabled={!connected || !!busy} onClick={toggleScreen} title={sharing ? 'Остановить трансляцию экрана' : `Трансляция экрана: ${SCREEN_PROFILES[screenProfile].label}, ${screenBitrate / 1_000_000} Мбит/с`} aria-label={sharing ? 'Остановить трансляцию экрана' : 'Начать трансляцию экрана'} aria-pressed={sharing}>{busy === 'screen' ? <LoaderCircle className="spin" size={21} /> : sharing ? <MonitorOff size={21} /> : <MonitorUp size={21} />}<span>Трансляция экрана</span></button>
      <button className={`call-control${settingsOpen ? ' active' : ''}`} onClick={() => { setSettingsOpen(value => !value); if (!settingsOpen) void listDevices(); }} aria-label="Настройки звука и видео" aria-expanded={settingsOpen}><Settings2 size={21} /><span>Настройки <ChevronDown size={12} /></span></button>
      <span className="toolbar-divider" />
      <button className="call-control leave-call" onClick={leave} aria-label="Выйти из голосового канала"><PhoneOff size={21} /><span>Выйти</span></button>
    </div><span className="toolbar-note"><span className="status-dot" />{connected ? 'WebRTC · защищённое соединение' : 'Ожидание подключения'}</span></div>
  </section>;
}
