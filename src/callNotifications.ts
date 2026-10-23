import { createElement as h, useEffect, useState } from 'react';
import './call-notifications.css';

type NotificationCall = {
  id: string;
  status: string;
  caller: { id: string; username: string };
  recipient: { id: string };
  expiresAt: string;
};
type IncomingCall = { id: string; username: string; expiresAt: number; recipientId: string };
type Preferences = { sound: boolean; notifications: boolean };
type Permission = NotificationPermission | 'unsupported';
const SETTINGS_KEY = 'signal.call-notifications.v1';
const SEEN_KEY = 'signal.call-notifications.seen.v1';
const PREFERENCES_EVENT = 'signal-call-notification-preferences';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const USERNAME = /^[A-Za-z0-9_-]{3,32}$/;
const active = new Map<string, IncomingCall>();
const browserNotifications = new Map<string, Notification>();
const seen = new Map<string, number>();
const deadlines = new Map<string, number>();
const oscillators = new Set<OscillatorNode>();
let audio: AudioContext | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let nextPulse = 0;
let currentUserId: string | null = null;

try {
  const rows: unknown = JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]');
  if (Array.isArray(rows)) for (const row of rows.slice(-200)) {
    if (Array.isArray(row) && typeof row[0] === 'string' && row[0].length <= 164 && typeof row[1] === 'number' && row[1] > Date.now() && row[1] < Date.now() + 120_000) seen.set(row[0], row[1]);
  }
} catch { /* Restricted storage still permits in-memory deduplication. */ }

export function getCallNotificationPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { sound: stored.sound !== false, notifications: typeof stored.notifications === 'boolean' ? stored.notifications : Boolean(window.signalDesktop?.notifyIncomingCall) };
  } catch { return { sound: true, notifications: Boolean(window.signalDesktop?.notifyIncomingCall) }; }
}

let preferences = getCallNotificationPreferences();
export function setCallNotificationPreferences(patch: Partial<Preferences>): Preferences {
  preferences = { ...preferences, ...(typeof patch.sound === 'boolean' ? { sound: patch.sound } : {}), ...(typeof patch.notifications === 'boolean' ? { notifications: patch.notifications } : {}) };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(preferences)); } catch { /* Preferences remain available for this session. */ }
  if (!preferences.sound) stopTones();
  if (!preferences.notifications) dismissNotifications();
  window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT));
  refresh();
  return { ...preferences };
}

export function callNotificationSupport(): { desktop: boolean; permission: Permission } {
  if (window.signalDesktop?.notifyIncomingCall) return { desktop: true, permission: 'granted' };
  if (!('Notification' in window) || !window.isSecureContext) return { desktop: false, permission: 'unsupported' };
  return { desktop: false, permission: Notification.permission };
}

// Call only from the explicit settings button; never request permission merely
// because somebody starts ringing or a websocket reconnects.
export async function enableCallNotifications(): Promise<{ enabled: boolean; permission: Permission }> {
  const support = callNotificationSupport();
  let permission = support.permission;
  if (support.desktop) {
    const available = await window.signalDesktop!.callNotificationsSupported().catch(() => false);
    if (!available) permission = 'unsupported';
  } else if (permission === 'default') {
    try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; }
  }
  const enabled = permission === 'granted';
  setCallNotificationPreferences({ notifications: enabled });
  return { enabled, permission };
}

function persistSeen() {
  const now = Date.now();
  for (const [key, expiry] of seen) if (expiry <= now) seen.delete(key);
  while (seen.size > 200) seen.delete(seen.keys().next().value!);
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch { /* Memory is sufficient if session storage is disabled. */ }
}

function stopTones() {
  for (const oscillator of oscillators) {
    try { oscillator.stop(); } catch { /* A completed oscillator is already stopped. */ }
    oscillator.disconnect();
  }
  oscillators.clear();
}

function pulse(preview = false) {
  if (!audio || audio.state !== 'running' || !preferences.sound || (!preview && active.size === 0)) return;
  const context = audio;
  for (const delay of [0, 0.3]) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, context.currentTime + delay);
    gain.gain.linearRampToValueAtTime(0.065, context.currentTime + delay + 0.025);
    gain.gain.setValueAtTime(0.065, context.currentTime + delay + 0.17);
    gain.gain.linearRampToValueAtTime(0, context.currentTime + delay + 0.23);
    gain.connect(context.destination);
    let remaining = 2;
    for (const frequency of [440, 660]) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      oscillator.connect(gain); oscillators.add(oscillator);
      oscillator.onended = () => { oscillators.delete(oscillator); oscillator.disconnect(); if (--remaining === 0) gain.disconnect(); };
      oscillator.start(context.currentTime + delay);
      oscillator.stop(context.currentTime + delay + 0.24);
    }
  }
}

function unlockAudio() {
  if (!preferences.sound) return;
  try {
    audio ||= new AudioContext();
    if (audio.state === 'suspended') void audio.resume().then(() => { nextPulse = 0; refresh(); }).catch(() => {});
    else refresh();
  } catch { /* The incoming-call card and notifications remain available. */ }
}
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio);

function dismissOne(id: string) {
  browserNotifications.get(id)?.close();
  browserNotifications.delete(id);
  void window.signalDesktop?.dismissCallNotification?.(id).catch(() => {});
}
function dismissNotifications() {
  for (const notification of browserNotifications.values()) notification.close();
  browserNotifications.clear();
  void window.signalDesktop?.dismissCallNotification?.().catch(() => {});
}

function notify(call: IncomingCall) {
  const key = `${call.recipientId}:${call.id}`;
  if (!preferences.notifications || seen.has(key)) return;
  const support = callNotificationSupport();
  if (support.permission !== 'granted') return;
  // Remember before invoking the OS, so duplicate WS events and snapshots
  // cannot enqueue another notification while the first IPC request is pending.
  seen.set(key, call.expiresAt + 60_000); persistSeen();
  if (support.desktop) {
    void window.signalDesktop!.notifyIncomingCall({ id: call.id, username: call.username, expiresAt: new Date(call.expiresAt).toISOString() }).catch(() => {});
  } else {
    try {
      const notification = new Notification('Входящий звонок в Сигнал', { body: `@${call.username} звонит вам`, tag: `signal-call-${call.id}`, silent: true });
      notification.onclick = () => { window.focus(); notification.close(); };
      notification.onclose = () => { if (browserNotifications.get(call.id) === notification) browserNotifications.delete(call.id); };
      browserNotifications.set(call.id, notification);
    } catch { /* Permission or OS notification settings may change at any time. */ }
  }
}

function refresh() {
  const now = Date.now();
  for (const [id, call] of active) {
    if (call.expiresAt <= now) { active.delete(id); dismissOne(id); }
    else notify(call);
  }
  if (!active.size) {
    if (timer) clearInterval(timer);
    timer = undefined; nextPulse = 0; stopTones(); return;
  }
  // The installed client can receive a call while it is already in the tray.
  // Browsers keep the explicit gesture unlock above; desktop tries its local
  // audio context immediately and still tolerates an OS playback restriction.
  if (preferences.sound && window.signalDesktop && !audio) {
    try {
      audio = new AudioContext();
      if (audio.state === 'suspended') void audio.resume().then(() => { nextPulse = 0; refresh(); }).catch(() => {});
    } catch { /* The native visual notification remains available. */ }
  }
  if (preferences.sound && audio?.state === 'running' && now >= nextPulse) { nextPulse = now + 2400; pulse(); }
  timer ||= setInterval(refresh, 250);
}

export function syncIncomingCallNotifications(calls: readonly NotificationCall[], userId: string | null) {
  if (!userId || !ID.test(userId)) { clearCallNotifications(); return; }
  if (currentUserId !== userId) clearCallNotifications();
  currentUserId = userId;
  const now = Date.now(), next = new Map<string, IncomingCall>();
  for (const call of calls) {
    if (!call || call.status !== 'pending' || call.recipient?.id !== userId || call.caller?.id === userId
      || typeof call.id !== 'string' || !ID.test(call.id) || typeof call.caller?.username !== 'string' || !USERNAME.test(call.caller.username)
      || typeof call.expiresAt !== 'string' || call.expiresAt.length > 40) continue;
    const expiresAt = Date.parse(call.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    // Repeated snapshots cannot extend ringing beyond this call's original
    // local deadline, even if a server timestamp is unexpectedly far ahead.
    const key = `${userId}:${call.id}`;
    if (!deadlines.has(key)) { while (deadlines.size >= 200) deadlines.delete(deadlines.keys().next().value!); deadlines.set(key, Math.min(expiresAt, now + 45_000)); }
    const deadline = deadlines.get(key)!;
    if (deadline <= now) continue;
    next.set(call.id, { id: call.id, username: call.caller.username, expiresAt: deadline, recipientId: userId });
  }
  for (const id of active.keys()) if (!next.has(id)) dismissOne(id);
  active.clear(); for (const [id, call] of next) active.set(id, call);
  refresh();
}

export function clearCallNotifications() {
  active.clear(); currentUserId = null;
  if (timer) clearInterval(timer);
  timer = undefined; nextPulse = 0; stopTones(); dismissNotifications();
}
window.addEventListener('pagehide', clearCallNotifications);
window.addEventListener('storage', event => {
  if (event.key === SETTINGS_KEY) { preferences = getCallNotificationPreferences(); if (!preferences.notifications) dismissNotifications(); if (!preferences.sound) stopTones(); window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT)); refresh(); }
});

export function CallNotificationSettings() {
  const [value, setValue] = useState(preferences), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    const changed = () => setValue({ ...preferences });
    window.addEventListener(PREFERENCES_EVENT, changed); window.addEventListener('focus', changed);
    return () => { window.removeEventListener(PREFERENCES_EVENT, changed); window.removeEventListener('focus', changed); };
  }, []);
  const support = callNotificationSupport();
  const enable = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await enableCallNotifications();
      setMessage(result.enabled ? 'Уведомления о входящих звонках включены.' : result.permission === 'denied' ? 'Уведомления заблокированы. Разрешите их в настройках сайта в браузере.' : 'Системные уведомления недоступны на этом устройстве. Карточка звонка и звук продолжат работать.');
    } finally { setBusy(false); }
  };
  const preview = async () => {
    try { audio ||= new AudioContext(); await audio.resume(); stopTones(); nextPulse = Date.now() + 2400; pulse(true); setMessage('Если звук не слышен, проверьте громкость Сигнала и устройство вывода звука.'); }
    catch { setMessage('Не удалось воспроизвести звук. Проверьте разрешение на звук для Сигнала в браузере.'); }
  };
  return h('section', { className: 'call-notification-settings', 'aria-label': 'Входящие личные звонки' },
    h('h3', null, 'Входящие личные звонки'),
    h('label', { className: 'checkbox-label' }, h('input', { type: 'checkbox', checked: value.sound, onChange: (event: { target: { checked: boolean } }) => { setCallNotificationPreferences({ sound: event.target.checked }); if (event.target.checked) unlockAudio(); } }), 'Звук входящего звонка'),
    h('button', { type: 'button', className: 'button secondary', disabled: !value.sound, onClick: () => { void preview(); } }, 'Прослушать звонок'),
    h('p', { className: 'settings-help' }, 'Звонок повторяется до ответа, отказа или завершения ожидания. В браузере звук станет доступен после вашего первого нажатия на странице.'),
    value.notifications ? h('label', { className: 'checkbox-label' }, h('input', { type: 'checkbox', checked: true, onChange: () => setCallNotificationPreferences({ notifications: false }) }), 'Системные уведомления о звонках')
      : h('button', { type: 'button', className: 'button secondary', disabled: busy || support.permission === 'unsupported', onClick: () => { void enable(); } }, busy ? 'Включаем…' : 'Включить уведомления о звонках'),
    h('p', { className: 'settings-help' }, 'Нажатие на уведомление открывает Сигнал. Ответить на звонок нужно отдельно.'),
    h('p', { className: 'settings-help' }, 'Для уведомлений Сигнал должен оставаться открыт: приложение Windows можно свернуть в трей, а вкладку браузера — оставить в фоне.'),
    support.permission === 'unsupported' && h('p', { className: 'settings-help' }, 'Системные уведомления не поддерживаются этим браузером.'),
    support.permission === 'denied' && h('p', { className: 'settings-help' }, 'Браузер заблокировал уведомления. Разрешите их в настройках этого сайта, затем включите уведомления здесь.'),
    message && h('p', { role: 'status' }, message));
}
