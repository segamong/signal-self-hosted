'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, session, protocol, net, ipcMain, desktopCapturer, globalShortcut, screen, Notification } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const WebSocket = require('ws');
const { SERVER_ORIGIN, SERVER_WEBSOCKET, APP_URL, PICKER_URL, isAppUrl, apiTarget, inviteCode, assetPath, isServerNetwork } = require('./security.cjs');
const { createManualUpdater } = require('./updater.cjs');
const { supportsOwnAudioExclusion } = require('./capture-audio.cjs');
const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
const screenAudioExcludesOwnAudio = supportsOwnAudioExclusion(os.platform(), os.release());

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName('Сигнал');
app.setAppUserModelId('cloud.signal.desktop');

let mainWindow = null;
let tray = null;
let clientSession = null;
let updater = null;
let quitting = false;
let quittingAfterFlush = false;
let authenticated = false;
let socket = null;
let connectingSocket = null;
let socketGeneration = 0;
let rendererReady = false;
const eventSnapshots = new Map();
const callNotifications = new Map();
const seenCallNotifications = new Map();
let retryTimer = null;
let retryAttempt = 0;
let capture = null;
let pendingInvites = [];
let settings = { openAtLogin: false, closeToTray: true, window: { width: 1440, height: 920, maximized: false } };

const CSP = `default-src 'none'; base-uri 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self' ${SERVER_ORIGIN} ${SERVER_ORIGIN.replace('https:', 'wss:')}; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'`;
const PICKER_CSP = "default-src 'none'; base-uri 'none'; script-src 'self'; style-src 'self'; img-src data:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";

function preferencesPath() { return path.join(app.getPath('userData'), 'desktop-settings.json'); }
function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    if (typeof raw.openAtLogin === 'boolean') settings.openAtLogin = raw.openAtLogin;
    if (typeof raw.closeToTray === 'boolean') settings.closeToTray = raw.closeToTray;
    if (raw.window && Number.isFinite(raw.window.width) && Number.isFinite(raw.window.height)) settings.window = {
      width: Math.min(3840, Math.max(980, raw.window.width)),
      height: Math.min(2160, Math.max(680, raw.window.height)),
      ...(Number.isFinite(raw.window.x) && Number.isFinite(raw.window.y) ? { x: raw.window.x, y: raw.window.y } : {}),
      maximized: raw.window.maximized === true,
    };
  } catch { /* First launch or invalid preferences: use defaults. */ }
}
function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const target = preferencesPath();
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(settings));
    fs.renameSync(`${target}.tmp`, target);
  } catch { /* Preferences are optional and contain no credentials. */ }
}
function publicSettings() { return { openAtLogin: isPortable ? false : settings.openAtLogin, closeToTray: settings.closeToTray }; }
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  settings.window = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
  saveSettings();
}
function isMainSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && isAppUrl(event.senderFrame.url));
}
function requireMainSender(event) { if (!isMainSender(event)) throw new Error('Недопустимый отправитель.'); }
function isPickerSender(event) {
  return Boolean(capture && !capture.window.isDestroyed() && event.sender === capture.window.webContents && event.senderFrame === capture.window.webContents.mainFrame && isAppUrl(event.senderFrame.url, 'picker'));
}
function requirePickerSender(event) { if (!isPickerSender(event)) throw new Error('Выбор источника уже закрыт.'); }
function sendEvent(value) {
  if (mainWindow && !mainWindow.isDestroyed() && isAppUrl(mainWindow.webContents.getURL())) mainWindow.webContents.send('signal:event', value);
}
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function dismissCallNotification(id) {
  const item = callNotifications.get(id);
  if (!item) return;
  callNotifications.delete(id);
  clearTimeout(item.timer);
  item.notification.close();
}
function dismissAllCallNotifications() {
  for (const id of [...callNotifications.keys()]) dismissCallNotification(id);
}
function notifyIncomingCall(value) {
  if (!authenticated || !Notification.isSupported() || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id)
    || typeof value.username !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(value.username)
    || typeof value.expiresAt !== 'string' || value.expiresAt.length > 40) throw new Error('Недопустимое уведомление о звонке.');
  const now = Date.now(), expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 46_000) return false;
  for (const [id, until] of seenCallNotifications) if (until <= now) seenCallNotifications.delete(id);
  if (seenCallNotifications.has(value.id)) return true;
  while (seenCallNotifications.size >= 200) seenCallNotifications.delete(seenCallNotifications.keys().next().value);
  seenCallNotifications.set(value.id, expiresAt + 60_000);
  try {
    const notification = new Notification({ title: 'Входящий звонок в Сигнал', body: `@${value.username} звонит вам`, silent: true, timeoutType: 'never' });
    const timer = setTimeout(() => dismissCallNotification(value.id), Math.max(1, expiresAt - now));
    timer.unref(); callNotifications.set(value.id, { notification, timer });
    notification.on('click', () => { showWindow(); dismissCallNotification(value.id); });
    notification.on('close', () => { const current = callNotifications.get(value.id); if (current?.notification === notification) { clearTimeout(current.timer); callNotifications.delete(value.id); } });
    notification.on('failed', () => dismissCallNotification(value.id));
    notification.show(); return true;
  } catch { dismissCallNotification(value.id); return false; }
}
function receiveInvite(value) {
  const code = inviteCode(value);
  if (!code) return;
  if (!pendingInvites.includes(code)) pendingInvites.push(code);
  pendingInvites = pendingInvites.slice(-10);
  if (app.isReady()) {
    showWindow();
    if (rendererReady) flushInvites();
  }
}
function flushInvites() {
  if (!rendererReady) return;
  for (const code of pendingInvites.splice(0)) sendEvent({ type: 'invite', code });
}
function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if ((event.url || target) !== window.webContents.getURL()) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event) => {
    // A same-document reload is needed by the connection error screen. Subframes
    // and navigation to any other document remain blocked.
    if (!event.isMainFrame || event.url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function stopSocket() {
  socketGeneration++;
  connectingSocket = null;
  eventSnapshots.clear();
  dismissAllCallNotifications();
  clearTimeout(retryTimer); retryTimer = null; retryAttempt = 0;
  const old = socket; socket = null;
  if (old) { old.removeAllListeners(); old.on('error', () => {}); old.close(); }
  sendEvent({ type: 'desktop-connection', connected: false });
}
function retrySocket() {
  if (!authenticated || quitting || retryTimer) return;
  const delay = Math.min(15000, 1000 * (2 ** Math.min(retryAttempt++, 4)));
  retryTimer = setTimeout(() => { retryTimer = null; void connectSocket(); }, delay);
}
async function connectSocket() {
  if (!authenticated || quitting || connectingSocket || socket) return;
  const attempt = {};
  const generation = socketGeneration;
  connectingSocket = attempt;
  try {
    const cookies = await clientSession.cookies.get({ url: SERVER_ORIGIN });
    if (!authenticated || quitting || generation !== socketGeneration) return;
    const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    const connection = new WebSocket(SERVER_WEBSOCKET, { origin: SERVER_ORIGIN, headers: { Cookie: cookie }, handshakeTimeout: 15000, maxPayload: 1024 * 1024, perMessageDeflate: false, followRedirects: false });
    socket = connection;
    connection.on('open', () => {
      retryAttempt = 0;
      sendEvent({ type: 'desktop-connection', connected: true });
    });
    connection.on('message', (payload, binary) => {
      if (binary) return;
      try {
        const data = JSON.parse(payload.toString());
        if (data && ['presence', 'channels', 'workspaces', 'friends', 'direct-calls', 'direct-call', 'message', 'message-updated', 'message-deleted', 'invitations', 'moderation'].includes(data.type)) {
          if (['presence', 'channels', 'workspaces', 'friends', 'direct-calls', 'invitations'].includes(data.type)) eventSnapshots.set(data.type, data);
          if (data.type === 'direct-call' && data.call && typeof data.call.id === 'string') {
            const calls = new Map((eventSnapshots.get('direct-calls')?.calls || []).map((call) => [call.id, call]));
            if (['pending', 'accepted'].includes(data.call.status)) calls.set(data.call.id, data.call); else calls.delete(data.call.id);
            eventSnapshots.set('direct-calls', { type: 'direct-calls', calls: [...calls.values()].slice(-200) });
            if (data.call.status !== 'pending') dismissCallNotification(data.call.id);
          }
          if (data.type === 'direct-calls' && Array.isArray(data.calls)) {
            const pending = new Set(data.calls.filter((call) => call?.status === 'pending').map((call) => call.id));
            for (const id of [...callNotifications.keys()]) if (!pending.has(id)) dismissCallNotification(id);
          }
          sendEvent(data);
        }
      } catch { /* The renderer only receives recognized JSON event types. */ }
    });
    connection.on('close', (code) => {
      if (socket !== connection) return;
      socket = null;
      if (code === 4001) authenticated = false;
      if (code === 4001) dismissAllCallNotifications();
      sendEvent({ type: 'desktop-connection', connected: false, code });
      retrySocket();
    });
    connection.on('error', () => { /* close / unexpected-response handles recovery. */ });
    connection.on('unexpected-response', (_request, response) => {
      if (socket !== connection) { response.resume(); return; }
      const code = response.statusCode === 401 ? 4001 : 1006;
      response.resume();
      if (socket === connection) socket = null;
      if (code === 4001) authenticated = false;
      sendEvent({ type: 'desktop-connection', connected: false, code });
      retrySocket();
    });
  } catch { if (generation === socketGeneration) retrySocket(); }
  finally { if (connectingSocket === attempt) connectingSocket = null; }
}

async function requestApi(pathname, body) {
  const method = body === undefined ? 'GET' : 'POST';
  let target, encoded;
  try {
    target = apiTarget(pathname, method);
    if (body !== undefined) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Ожидается объект запроса.');
      encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > 32 * 1024) throw new Error('Слишком большой запрос.');
    }
  } catch (error) { return { status: 400, data: { error: error.message } }; }
  try {
    // Chromium session owns Secure / HttpOnly cookies; neither cookie headers nor
    // session credentials are exposed through the renderer bridge.
    const response = await clientSession.fetch(target, {
      method, credentials: 'include', redirect: 'error', cache: 'no-store',
      headers: { Origin: SERVER_ORIGIN, Accept: 'application/json', ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(encoded === undefined ? {} : { body: encoded }),
      signal: AbortSignal.timeout(20000),
    });
    const text = response.status === 204 ? '' : await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { data = { error: 'Сервер вернул неожиданный ответ.' }; }
    if (response.ok && ['/api/login', '/api/register', '/api/me'].includes(pathname)) {
      if (pathname !== '/api/me') stopSocket();
      authenticated = Boolean(data?.user);
      if (authenticated) void connectSocket(); else stopSocket();
      await clientSession.cookies.flushStore();
    }
    if (response.ok && pathname === '/api/logout') {
      authenticated = false; stopSocket();
      await clientSession.cookies.flushStore();
    }
    if (response.status === 401 && pathname !== '/api/login' && pathname !== '/api/register') {
      authenticated = false; stopSocket();
      sendEvent({ type: 'desktop-connection', connected: false, code: 4001 });
    }
    return { status: response.status, data };
  } catch {
    return { status: 503, data: { error: 'Не удалось связаться с сервером. Проверьте интернет и повторите попытку.' } };
  }
}

function finishCapture(selection) {
  if (!capture) return;
  const pending = capture; capture = null;
  clearTimeout(pending.timer);
  if (!pending.window.isDestroyed()) pending.window.destroy();
  try {
    if (!selection || !mainWindow || mainWindow.isDestroyed() || pending.frame !== mainWindow.webContents.mainFrame || !isAppUrl(pending.frame.url)) return pending.callback(null);
    const source = pending.sources.find((item) => item.id === selection.id);
    if (!source) return pending.callback(null);
    pending.callback({ video: source, ...(selection.audio && pending.audioAvailable && screenAudioExcludesOwnAudio ? { audio: 'loopback' } : {}) });
  } catch { /* Destroyed frame: Chromium already rejects the request. */ }
}

function configureSession() {
  clientSession = session.fromPartition('persist:signal');
  clientSession.protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method) || url.username || url.password || url.port || !['signal', 'picker'].includes(url.hostname)) return new Response('Not found', { status: 404 });
    const root = url.hostname === 'signal' ? path.join(__dirname, '..', 'dist') : path.join(__dirname, 'picker');
    const filename = assetPath(root, url.pathname);
    if (!filename || !fs.existsSync(filename) || !fs.statSync(filename).isFile() || filename.endsWith('.cjs')) return new Response('Not found', { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(filename).href);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', url.hostname === 'signal' ? CSP : PICKER_CSP);
      if (filename.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-store');
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  clientSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAppUrl(details.url) || isAppUrl(details.url, 'picker') || isServerNetwork(details.url) || details.url.startsWith('blob:app://signal/');
    callback({ cancel: !allowed });
  });
  clientSession.webRequest.onHeadersReceived({ urls: [`${SERVER_ORIGIN}/`] }, (details, callback) => {
    // LiveKit probes its fixed server root with HEAD when Windows reconnects.
    // The packaged renderer is a separate origin. Grant only that harmless,
    // credential-free probe; API, media, local CSP and other responses are intact.
    if (details.method !== 'HEAD' || details.url !== `${SERVER_ORIGIN}/`
      || !mainWindow || mainWindow.isDestroyed() || details.webContentsId !== mainWindow.webContents.id
      || details.frame !== mainWindow.webContents.mainFrame || details.initiatorOrigin !== 'app://signal') return callback({});
    const headers = Object.fromEntries(Object.entries(details.responseHeaders || {}).filter(([name]) => !['access-control-allow-origin', 'access-control-allow-credentials'].includes(name.toLowerCase())));
    headers['Access-Control-Allow-Origin'] = ['app://signal'];
    callback({ responseHeaders: headers });
  });
  const permissionAllowed = (contents, permission, origin, details = {}) => {
    if (!mainWindow || mainWindow.isDestroyed() || contents !== mainWindow.webContents || !isAppUrl(contents.getURL()) || !isAppUrl(origin) || details.isMainFrame === false) return false;
    if (permission === 'media') return !details.mediaTypes || details.mediaTypes.every((type) => ['audio', 'video'].includes(type));
    return ['display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection'].includes(permission);
  };
  clientSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permissionAllowed(contents, permission, details.requestingUrl || contents.getURL(), details));
  });
  clientSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => permissionAllowed(contents, permission, requestingOrigin, details));
  clientSession.setDevicePermissionHandler(() => false);
  clientSession.on('will-download', (event) => event.preventDefault());
  clientSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (capture || !mainWindow || mainWindow.isDestroyed() || request.frame !== mainWindow.webContents.mainFrame || !isAppUrl(request.frame?.url) || !isAppUrl(request.securityOrigin) || !request.videoRequested || !request.userGesture) return callback(null);
    const picker = new BrowserWindow({
      parent: mainWindow, modal: true, title: 'Выберите экран · Сигнал', width: 800, height: 750,
      minWidth: 650, minHeight: 560, show: false, autoHideMenuBar: true, backgroundColor: '#11131c',
      webPreferences: { session: clientSession, preload: path.join(__dirname, 'picker', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    capture = { window: picker, callback, frame: request.frame, sources: [], audioAvailable: screenAudioExcludesOwnAudio && request.audioRequested, timer: setTimeout(() => finishCapture(null), 120000) };
    hardenWindow(picker);
    picker.on('closed', () => { if (capture?.window === picker) finishCapture(null); });
    picker.once('ready-to-show', () => picker.show());
    picker.loadURL(PICKER_URL).catch(() => finishCapture(null));
  });
}

function configureIpc() {
  ipcMain.handle('signal:info', (event) => { requireMainSender(event); return { version: app.getVersion(), serverOrigin: SERVER_ORIGIN, platform: process.platform, packaged: app.isPackaged, portable: isPortable, screenAudioExcludesOwnAudio }; });
  ipcMain.handle('signal:api', (event, pathname, body) => { requireMainSender(event); return requestApi(pathname, body); });
  ipcMain.handle('signal:update-state', (event) => { requireMainSender(event); return updater.getState(); });
  ipcMain.handle('signal:update-check', (event) => { requireMainSender(event); return updater.checkUpdate(); });
  ipcMain.handle('signal:update-download', (event) => { requireMainSender(event); return updater.downloadUpdate(); });
  ipcMain.handle('signal:update-install', (event) => { requireMainSender(event); return updater.installUpdate(); });
  ipcMain.on('signal:events-ready', (event) => {
    if (!isMainSender(event)) return;
    rendererReady = true;
    sendEvent({ type: 'desktop-connection', connected: socket?.readyState === WebSocket.OPEN });
    // The session /me request may establish the socket before React mounts its
    // account-specific listeners. Replay state; individual messages stay live.
    for (const snapshot of eventSnapshots.values()) sendEvent(snapshot);
    sendEvent({ type: 'desktop-update', ...updater.getState() });
    flushInvites();
  });
  ipcMain.handle('signal:window', (event, action) => {
    requireMainSender(event);
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === 'close') mainWindow.close();
    else throw new Error('Неизвестное действие.');
  });
  ipcMain.handle('signal:show', (event) => { requireMainSender(event); showWindow(); });
  ipcMain.handle('signal:call-notifications-supported', (event) => { requireMainSender(event); return Notification.isSupported(); });
  ipcMain.handle('signal:call-notify', (event, value) => { requireMainSender(event); return notifyIncomingCall(value); });
  ipcMain.handle('signal:call-notification-dismiss', (event, callId) => {
    requireMainSender(event);
    if (callId === undefined) dismissAllCallNotifications();
    else if (typeof callId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(callId)) dismissCallNotification(callId);
    else throw new Error('Недопустимый идентификатор звонка.');
  });
  ipcMain.handle('signal:settings-get', (event) => { requireMainSender(event); return publicSettings(); });
  ipcMain.handle('signal:settings-set', (event, value) => {
    requireMainSender(event);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['openAtLogin', 'closeToTray'].includes(key))) throw new Error('Недопустимые настройки.');
    if (value.openAtLogin !== undefined) {
      if (typeof value.openAtLogin !== 'boolean') throw new Error('Некорректный параметр автозапуска.');
      if (isPortable && value.openAtLogin) throw new Error('Автозапуск доступен в установленной версии. Portable запускается из временной папки; установите Сигнал через Signal-Setup.');
      if (!app.isPackaged && value.openAtLogin) throw new Error('Автозапуск доступен после установки приложения.');
      // A portable run must not overwrite the installed copy's login entry.
      if (!isPortable) {
        app.setLoginItemSettings({ openAtLogin: value.openAtLogin, path: process.execPath, args: ['--start-hidden'] });
        settings.openAtLogin = value.openAtLogin;
      }
    }
    if (value.closeToTray !== undefined) {
      if (typeof value.closeToTray !== 'boolean') throw new Error('Некорректный параметр закрытия.');
      settings.closeToTray = value.closeToTray;
    }
    saveSettings(); return publicSettings();
  });
  ipcMain.handle('signal:picker-sources', async (event) => {
    requirePickerSender(event);
    const current = capture;
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: false });
    if (capture !== current || !isPickerSender(event)) throw new Error('Выбор источника уже закрыт.');
    current.sources = sources.filter((source) => !source.name.includes('Выберите экран · Сигнал'));
    return { sources: current.sources.map((source) => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })), audioAvailable: current.audioAvailable };
  });
  ipcMain.handle('signal:picker-select', (event, selection) => {
    requirePickerSender(event);
    if (!selection || typeof selection.id !== 'string' || typeof selection.audio !== 'boolean' || !capture.sources.some((source) => source.id === selection.id)) throw new Error('Источник больше недоступен.');
    finishCapture(selection); return true;
  });
  ipcMain.handle('signal:picker-cancel', (event) => { requirePickerSender(event); finishCapture(null); return true; });
}

function createMainWindow() {
  const bounds = { ...settings.window };
  const maximized = bounds.maximized; delete bounds.maximized;
  const displays = screen.getAllDisplays();
  if (!displays.some(({ workArea }) => Number.isFinite(bounds.x) && Number.isFinite(bounds.y) && bounds.x + 100 > workArea.x && bounds.y + 100 > workArea.y && bounds.x < workArea.x + workArea.width - 100 && bounds.y < workArea.y + workArea.height - 100)) { delete bounds.x; delete bounds.y; }
  mainWindow = new BrowserWindow({
    ...bounds, minWidth: 980, minHeight: 680, title: 'Сигнал', frame: false,
    show: false, backgroundColor: '#101119', autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { session: clientSession, preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  hardenWindow(mainWindow);
  mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; });
  mainWindow.on('close', (event) => {
    saveWindowState();
    if (!quitting && settings.closeToTray && tray) { event.preventDefault(); mainWindow.hide(); }
    else if (!quitting) { event.preventDefault(); app.quit(); }
  });
  mainWindow.on('closed', () => { rendererReady = false; mainWindow = null; });
  mainWindow.webContents.on('render-process-gone', () => { rendererReady = false; authenticated = false; stopSocket(); finishCapture(null); });
  mainWindow.once('ready-to-show', () => {
    if (maximized) mainWindow.maximize();
    if (!process.argv.includes('--start-hidden')) mainWindow.show();
  });
  void mainWindow.loadURL(APP_URL);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('Сигнал · Общение через ваш сервер');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Сигнал', click: showWindow },
    { label: 'Выключить / включить микрофон', click: () => sendEvent({ type: 'toggle-microphone' }) },
    { type: 'separator' },
    { label: 'Выйти из приложения', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  for (const value of process.argv) receiveInvite(value);
  app.on('second-instance', (_event, argv) => { showWindow(); for (const value of argv) receiveInvite(value); });
  app.on('open-url', (event, value) => { event.preventDefault(); receiveInvite(value); });
  app.on('before-quit', (event) => {
    quitting = true;
    saveWindowState();
    authenticated = false; stopSocket(); finishCapture(null);
    if (clientSession && !quittingAfterFlush) {
      event.preventDefault();
      quittingAfterFlush = true;
      Promise.allSettled([clientSession.cookies.flushStore(), updater?.dispose()]).finally(() => app.quit());
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.whenReady().then(() => {
    readSettings(); configureSession();
    updater = createManualUpdater({ currentVersion: app.getVersion(), userData: app.getPath('userData'), emit: (state) => sendEvent({ type: 'desktop-update', ...state }), onInstallLaunched: () => app.quit() });
    configureIpc();
    Menu.setApplicationMenu(null);
    if (app.isPackaged && !isPortable) app.setAsDefaultProtocolClient('signal');
    createMainWindow(); createTray();
    globalShortcut.register('CommandOrControl+Shift+M', () => sendEvent({ type: 'toggle-microphone' }));
    app.on('activate', showWindow);
  }).catch(() => app.quit());
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}
