import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { openDatabase, publicUser, migrateChannelMemberships, migrateDirectInvitations, migrateChannelModeration, migratePrivateCalls, migrateCommunities } from './database.mjs';
import { createCommunityService } from './community.mjs';
import { createMedia, MAX_PARTICIPANTS } from './media.mjs';
import { installModerationRoutes } from './moderation.mjs';
import { installMessageTools, messageExtras } from './message-tools.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'signal_session';
const USERNAME = /^[a-zA-Z0-9_-]{3,32}$/;
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$65536$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function passwordMatches(password, encoded) {
  const [, n, r, p, salt, expected] = encoded.split('$');
  const derived = await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  const stored = Buffer.from(expected, 'hex');
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value) <= 512;
}

function readCookie(req) {
  const match = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const value = match.slice(COOKIE_NAME.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function createApp(options = {}) {
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const production = env.NODE_ENV === 'production';
  let appOrigin;
  if (env.APP_ORIGIN) {
    const parsed = new URL(env.APP_ORIGIN);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== env.APP_ORIGIN.replace(/\/$/, '')) throw new Error('APP_ORIGIN должен содержать только схему и адрес, например https://chat.example.com');
    if (production && parsed.protocol !== 'https:') throw new Error('В production APP_ORIGIN должен использовать HTTPS');
    appOrigin = parsed.origin;
  } else if (production) {
    throw new Error('Для production задайте APP_ORIGIN=https://адрес-приложения');
  }
  const dataDir = options.dataDir || env.DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../data');
  const db = openDatabase(dataDir);
  try {
    if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
      if (!USERNAME.test(env.ADMIN_USERNAME || '') || !validPassword(env.ADMIN_PASSWORD)) {
        throw new Error('Первый запуск: задайте ADMIN_USERNAME (3–32 латинских символа) и ADMIN_PASSWORD (12–128 символов). Общего пароля по умолчанию нет.');
      }
      const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
      db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), env.ADMIN_USERNAME.toLowerCase(), env.ADMIN_USERNAME.toLowerCase(), passwordHash, 'admin', clock());
    }
    migrateChannelMemberships(db, clock());
    migrateDirectInvitations(db, clock());
    migrateChannelModeration(db, clock());
    migratePrivateCalls(db, clock());
    migrateCommunities(db, clock());
  } catch (error) { db.close(); throw error; }

  let dummyHash, media;
  try {
    dummyHash = await hashPassword(randomBytes(24).toString('hex'));
    media = options.media || createMedia(env);
  } catch (error) { db.close(); throw error; }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === '1' ? 1 : false);
  const server = createServer(app);
  server.requestTimeout = 20_000;
  server.headersTimeout = 25_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const sockets = new Map();
  let communities;
  const rateBuckets = new Map();
  const connectOrigins = new Set(["'self'"]);
  if (appOrigin) connectOrigins.add(appOrigin.replace(/^http/, 'ws'));
  if (env.LIVEKIT_PUBLIC_URL) {
    try {
      const mediaOrigin = new URL(env.LIVEKIT_PUBLIC_URL).origin;
      connectOrigins.add(mediaOrigin);
      connectOrigins.add(mediaOrigin.replace(/^ws/, 'http'));
    } catch { /* An incomplete media configuration remains unavailable. */ }
  }

  function enforceRate(key, limit, intervalMs) {
    const now = clock();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (rateBuckets.size >= 10_000) {
        for (const [oldKey, old] of rateBuckets) if (old.until <= now) rateBuckets.delete(oldKey);
        if (rateBuckets.size >= 10_000) throw new HttpError(503, 'Сервис занят. Повторите запрос позже.');
      }
      bucket = { count: 0, until: now + intervalMs };
      rateBuckets.set(key, bucket);
    }
    if (++bucket.count > limit) throw new HttpError(429, 'Слишком много запросов. Попробуйте позже.');
  }

  const selectMemberChannel = `SELECT channels.id, COALESCE(channels.label, channels.name) AS name, channels.description, channels.kind, channels.workspace_id AS workspaceId, channels.channel_type AS channelType, channels.legacy_voice_compatible AS legacyVoiceCompatible, channels.owner_id AS ownerId, memberships.role, memberships.muted
    FROM channels JOIN memberships ON memberships.channel_id = channels.id`;
  const channelBanFilter = `NOT EXISTS (SELECT 1 FROM channel_bans WHERE channel_bans.channel_id = channels.id AND channel_bans.user_id = memberships.user_id)
    AND (channels.workspace_id IS NULL OR (EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = channels.workspace_id AND user_id = memberships.user_id)
      AND NOT EXISTS (SELECT 1 FROM workspace_bans WHERE workspace_id = channels.workspace_id AND user_id = memberships.user_id)))`;
  function channelDto(channel, userId) {
    if (channel.kind !== 'direct') return { ...channel, kind: 'channel', maxParticipants: MAX_PARTICIPANTS, muted: Boolean(channel.muted) };
    const pair = db.prepare('SELECT first_user_id, second_user_id FROM direct_conversations WHERE channel_id = ?').get(channel.id);
    if (!pair || ![pair.first_user_id, pair.second_user_id].includes(userId)) throw new HttpError(404, 'Канал не найден.');
    const peer = db.prepare('SELECT id, username FROM users WHERE id = ?').get(pair.first_user_id === userId ? pair.second_user_id : pair.first_user_id);
    return { ...channel, name: peer.username, description: 'Личный разговор', workspaceId: null, channelType: 'direct', ownerId: null, role: 'member', muted: false, maxParticipants: 2, peer };
  }
  const listChannels = (userId) => db.prepare(`${selectMemberChannel} WHERE memberships.user_id = ? AND ${channelBanFilter} ORDER BY channels.created_at, channels.id`).all(userId).map((channel) => channelDto(channel, userId));
  const getChannel = (id, userId) => {
    const channel = db.prepare(`${selectMemberChannel} WHERE channels.id = ? AND memberships.user_id = ? AND ${channelBanFilter}`).get(id, userId);
    if (!channel) throw new HttpError(404, 'Канал не найден.');
    return channelDto(channel, userId);
  };
  function requireGroupChannel(channel) {
    if (channel.kind === 'direct') throw new HttpError(403, 'В личном разговоре могут участвовать только два выбранных аккаунта.');
  }
  function getMediaKey(channelId) {
    db.prepare('INSERT OR IGNORE INTO channel_media_keys (channel_id, key, epoch, reset_pending) VALUES (?, ?, 1, 0)').run(channelId, randomBytes(32).toString('base64url'));
    return db.prepare('SELECT key, epoch, reset_pending FROM channel_media_keys WHERE channel_id = ?').get(channelId);
  }
  function rotateMediaKey(channelId) {
    db.prepare(`INSERT INTO channel_media_keys (channel_id, key, epoch, reset_pending) VALUES (?, ?, 1, 1)
      ON CONFLICT(channel_id) DO UPDATE SET key = excluded.key, epoch = channel_media_keys.epoch + 1, reset_pending = 1`).run(channelId, randomBytes(32).toString('base64url'));
  }
  const mediaResets = new Map();
  async function resetMediaRoom(channelId) {
    if (mediaResets.has(channelId)) return mediaResets.get(channelId);
    const operation = (async () => {
      for (;;) {
        const key = db.prepare('SELECT epoch, reset_pending FROM channel_media_keys WHERE channel_id = ?').get(channelId);
        if (!key?.reset_pending) return true;
        try {
          if (!media.configured || typeof media.deleteChannel !== 'function') return false;
          await media.deleteChannel(channelId);
          db.prepare('UPDATE channel_media_keys SET reset_pending = 0 WHERE channel_id = ? AND epoch = ?').run(channelId, key.epoch);
        } catch { return false; }
      }
    })();
    mediaResets.set(channelId, operation);
    try { return await operation; } finally { mediaResets.delete(channelId); }
  }
  async function drainMediaResets() {
    await Promise.allSettled(db.prepare('SELECT channel_id FROM channel_media_keys WHERE reset_pending = 1 LIMIT 100').all().map((row) => resetMediaRoom(row.channel_id)));
  }
  const isBanned = (channelId, userId) => Boolean(db.prepare(`SELECT 1 FROM channel_bans WHERE channel_id = ? AND user_id = ?
    UNION ALL SELECT 1 FROM workspace_bans JOIN channels ON channels.workspace_id = workspace_bans.workspace_id WHERE channels.id = ? AND workspace_bans.user_id = ? LIMIT 1`).get(channelId, userId, channelId, userId));
  const assertNotBanned = (channelId, userId) => { if (isBanned(channelId, userId)) throw new HttpError(403, 'Доступ в этот канал заблокирован.'); };
  const hasMembership = (channelId, userId) => Boolean(db.prepare(`${selectMemberChannel} WHERE channels.id = ? AND memberships.user_id = ? AND ${channelBanFilter}`).get(channelId, userId));
  const listMembers = (channelId) => db.prepare(`SELECT users.id, users.username, memberships.role, memberships.muted FROM users JOIN memberships ON memberships.user_id = users.id JOIN channels ON channels.id = memberships.channel_id WHERE memberships.channel_id = ? AND ${channelBanFilter} ORDER BY CASE memberships.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, users.username COLLATE NOCASE, users.id`).all(channelId).map((member) => ({ ...member, muted: Boolean(member.muted) }));
  const getInvite = (code) => {
    if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{32}$/.test(code)) throw new HttpError(404, 'Приглашение не найдено.');
    const invite = db.prepare(`SELECT invites.*, COALESCE(workspaces.name, channels.label, channels.name) AS channel_name, channels.workspace_id FROM invites JOIN channels ON channels.id = invites.channel_id LEFT JOIN workspaces ON workspaces.id = channels.workspace_id WHERE invites.code_hash = ? AND channels.kind = 'channel'`).get(tokenHash(code));
    if (!invite) throw new HttpError(404, 'Приглашение не найдено.');
    return invite;
  };
  const selectInvitation = `SELECT channel_invitations.*, COALESCE(workspaces.name, channels.label, channels.name) AS channel_name, COALESCE(workspaces.description, channels.description) AS channel_description, channels.workspace_id, channels.kind AS channel_kind, users.username AS inviter_username
    FROM channel_invitations JOIN channels ON channels.id = channel_invitations.channel_id LEFT JOIN workspaces ON workspaces.id = channels.workspace_id JOIN users ON users.id = channel_invitations.created_by`;
  function publicInvitation(row) {
    return {
      id: row.id,
      channel: { id: row.channel_id, name: row.channel_kind === 'direct' ? row.inviter_username : row.channel_name, description: row.channel_kind === 'direct' ? 'Личный разговор' : row.channel_description, kind: row.channel_kind, workspaceId: row.workspace_id, maxParticipants: row.channel_kind === 'direct' ? 2 : MAX_PARTICIPANTS },
      inviter: { id: row.created_by, username: row.inviter_username },
      createdAt: new Date(Number(row.created_at)).toISOString(),
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
      status: row.status,
    };
  }
  const listInvitations = (userId) => db.prepare(`${selectInvitation} WHERE channel_invitations.recipient_id = ? AND channel_invitations.status = 'pending' AND channel_invitations.expires_at > ? AND NOT EXISTS (SELECT 1 FROM channel_bans WHERE channel_bans.channel_id = channel_invitations.channel_id AND channel_bans.user_id = channel_invitations.recipient_id) ORDER BY channel_invitations.created_at DESC, channel_invitations.id`).all(userId, clock()).map(publicInvitation);
  const invitationById = (id, recipientId) => db.prepare(`${selectInvitation} WHERE channel_invitations.id = ? AND channel_invitations.recipient_id = ?`).get(id, recipientId);
  function sessionUser(req) {
    const token = readCookie(req);
    if (!token) return null;
    const row = db.prepare('SELECT users.*, sessions.expires_at FROM users JOIN sessions ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?').get(tokenHash(token), clock());
    return row ? { user: publicUser(row), expiresAt: Number(row.expires_at), tokenHash: tokenHash(token) } : null;
  }
  const expectedOrigin = (req) => appOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return false;
    try { return new URL(origin).origin === origin && origin === expectedOrigin(req); } catch { return false; }
  };
  function requireAuth(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'Войдите в аккаунт.' });
    next();
  }
  function createSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(clock());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), userId, clock() + SESSION_MS);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure: production, path: '/', maxAge: SESSION_MS });
  }
  function sendClient(ws, client, payload) {
    if (client.expiresAt <= clock()) { ws.close(4001, 'Сессия истекла'); return; }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(payload));
  }
  function broadcastChannels(userId) {
    for (const [ws, client] of sockets) if (!userId || client.user.id === userId) {
      sendClient(ws, client, { type: 'channels', channels: listChannels(client.user.id) });
    }
    communities?.broadcastWorkspaces(userId);
  }
  function broadcastInvitations(userId) {
    for (const [ws, client] of sockets) if (client.user.id === userId) sendClient(ws, client, { type: 'invitations', invitations: listInvitations(userId) });
  }
  function notifyModeration(channelId, action, userId, recipients = [userId]) {
    const allowed = new Set(recipients);
    for (const [ws, client] of sockets) if (allowed.has(client.user.id)) sendClient(ws, client, { type: 'moderation', channelId, action, userId: action === 'delete' ? client.user.id : userId });
  }
  function syncMediaUsernames(userId) {
    if (!media.configured || typeof media.syncUsernames !== 'function') return;
    const accounts = userId ? db.prepare('SELECT id, username FROM users WHERE id = ?').all(userId) : db.prepare('SELECT id, username FROM users').all();
    const channelIds = db.prepare('SELECT id FROM channels').all().map((channel) => channel.id);
    void media.syncUsernames(accounts, channelIds).catch(() => console.warn('Не удалось обновить подписи активных участников медиасервера.'));
  }
  function broadcastMessage(message) {
    for (const [ws, client] of sockets) if (hasMembership(message.channelId, client.user.id)) sendClient(ws, client, { type: 'message', message });
  }
  function broadcastToChannel(channelId, payload) {
    for (const [ws, client] of sockets) if (hasMembership(channelId, client.user.id)) sendClient(ws, client, payload);
  }
  function broadcastPresence() {
    const online = [...new Map([...sockets.values()].filter((client) => client.expiresAt > clock()).map((client) => [client.user.id, client.user])).values()];
    for (const [ws, client] of sockets) {
      const visible = new Set(db.prepare(`SELECT DISTINCT other.user_id AS id FROM memberships own JOIN memberships other ON other.channel_id = own.channel_id WHERE own.user_id = ? AND NOT EXISTS (SELECT 1 FROM channel_bans WHERE channel_bans.channel_id = own.channel_id AND channel_bans.user_id IN (own.user_id, other.user_id))`).all(client.user.id).map((row) => row.id));
      visible.add(client.user.id);
      for (const friend of communities?.listFriends(client.user.id).friends || []) visible.add(friend.id);
      sendClient(ws, client, { type: 'presence', online: online.filter((user) => visible.has(user.id)) });
    }
    communities?.broadcastFriends();
  }
  function messageFromRow(row) {
    return { id: Number(row.id), channelId: row.channel_id, content: row.content, createdAt: new Date(Number(row.created_at)).toISOString(), user: { id: row.user_id, username: row.username, displayName: row.username, role: row.role }, ...messageExtras(db, row.id) };
  }
  const selectMessage = 'SELECT messages.*, users.username, users.role FROM messages JOIN users ON users.id = messages.user_id';
  communities = createCommunityService({ app, db, clock, HttpError, requireAuth, enforceRate, sockets, sendClient, getChannel, listChannels, broadcastChannels, broadcastPresence, broadcastInvitations, rotateMediaKey, resetMediaRoom });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
    if (production) res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src ${[...connectOrigins].join(' ')}; worker-src 'self' blob:; object-src 'none'`);
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Caddy forward_auth calls this only through the loopback listener. Public
  // /internal/* routes must be denied by Caddy before its generic app handler.
  app.get('/internal/media-access', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || typeof media.verifyAccessToken !== 'function') return res.status(403).end();
    try {
      const uri = req.headers['x-forwarded-uri'];
      if (typeof uri !== 'string' || uri.length > 16_384 || !uri.startsWith('/')) return res.status(403).end();
      const url = new URL(uri, 'http://loopback');
      if (url.pathname !== '/rtc' && !url.pathname.startsWith('/rtc/')) return res.status(403).end();
      const bearer = typeof req.headers.authorization === 'string' ? req.headers.authorization.match(/^Bearer (\S+)$/i)?.[1] : undefined;
      const token = url.searchParams.get('access_token') || bearer;
      if (!token || token.length > 12_000) return res.status(403).end();
      const claims = await media.verifyAccessToken(token);
      if (typeof claims.sub !== 'string' || claims.video?.roomJoin !== true || typeof claims.video.room !== 'string') return res.status(403).end();
      const channel = getChannel(claims.video.room, claims.sub);
      const account = db.prepare('SELECT username FROM users WHERE id = ?').get(claims.sub);
      const key = db.prepare('SELECT epoch, reset_pending FROM channel_media_keys WHERE channel_id = ?').get(channel.id);
      if (!account || !key || key.reset_pending || claims.name !== account.username || claims.metadata !== JSON.stringify({ username: account.username, encryptionEpoch: String(key.epoch) })) return res.status(403).end();
      if (channel.muted && (claims.video.canPublish !== false || claims.video.canPublishSources?.length)) return res.status(403).end();
      res.status(204).end();
    } catch { res.status(403).end(); }
  });
  app.use('/internal', (req, res) => res.status(404).end());
  app.use('/api', (req, res, next) => {
    try {
      enforceRate(`api:${req.ip}`, 180, 60_000);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(req)) throw new HttpError(403, 'Запрос разрешён только с адреса приложения.');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) throw new HttpError(415, 'Требуется Content-Type: application/json.');
      req.auth = sessionUser(req);
      next();
    } catch (error) { next(error); }
  });
  app.use('/api', express.json({ limit: '16kb', strict: true }));

  app.get('/api/health', (req, res) => res.json({ ok: true, mediaConfigured: media.configured }));
  app.get('/api/config', (req, res) => res.json({ name: 'Сигнал', version: APP_VERSION, maxParticipants: MAX_PARTICIPANTS, mediaConfigured: media.configured, mediaEncryptionRequired: true, mediaEncryptionVersion: 1 }));
  app.get('/api/me', (req, res) => res.json({ user: req.auth?.user || null }));
  app.post('/api/login', async (req, res) => {
    enforceRate(`login:${req.ip}`, 10, 15 * 60_000);
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || username.length > 32 || typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password) > 512) throw new HttpError(400, 'Укажите имя пользователя и пароль.');
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase());
    if (!await passwordMatches(password, row?.password_hash || dummyHash) || !row) throw new HttpError(401, 'Неверное имя пользователя или пароль.');
    createSession(res, row.id);
    syncMediaUsernames(row.id);
    res.json({ user: publicUser(row) });
  });
  app.post('/api/register', async (req, res) => {
    enforceRate(`register:${req.ip}`, 5, 60 * 60_000);
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !USERNAME.test(username)) throw new HttpError(400, 'Имя: 3–32 латинские буквы, цифры, дефис или подчёркивание.');
    if (!validPassword(password)) throw new HttpError(400, 'Пароль должен содержать от 12 до 128 символов.');
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase())) throw new HttpError(409, 'Это имя уже занято.');
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    try {
      db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, username.toLowerCase(), username.toLowerCase(), passwordHash, 'member', clock());
    } catch (error) { if (error.code?.startsWith('ERR_SQLITE') && error.message.includes('UNIQUE')) throw new HttpError(409, 'Это имя уже занято.'); throw error; }
    createSession(res, id);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  });
  app.post('/api/logout', requireAuth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.auth.tokenHash);
    for (const [ws, client] of sockets) if (client.tokenHash === req.auth.tokenHash) ws.close(4001, 'Вы вышли из аккаунта');
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: production, path: '/' });
    res.status(204).end();
  });
  app.get('/api/channels', requireAuth, (req, res) => res.json({ channels: listChannels(req.auth.user.id) }));
  app.post('/api/channels', requireAuth, (req, res) => {
    enforceRate(`channels:${req.auth.user.id}`, 10, 60_000);
    const result = communities.createWorkspace(req.auth.user.id, req.body);
    res.status(201).json({ ...result, channel: result.channels.find((channel) => channel.channelType === 'text') });
  });
  app.post('/api/direct-channels', requireAuth, (req, res) => {
    enforceRate(`direct-channels:${req.auth.user.id}`, 20, 60_000);
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().replace(/^@/, '').toLowerCase() : '';
    if (!USERNAME.test(username)) throw new HttpError(400, 'Укажите никнейм друга: 3–32 латинские буквы, цифры, дефис или подчёркивание.');
    const userId = req.auth.user.id;
    const recipient = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
    if (!recipient) throw new HttpError(404, 'Пользователь не найден.');
    if (recipient.id === userId) throw new HttpError(400, 'Нельзя создать личный разговор с собой.');
    if (communities.areFriends(userId, recipient.id)) {
      db.exec('BEGIN IMMEDIATE');
      let conversation;
      try { conversation = communities.ensureFriendConversation(userId, recipient.id); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      broadcastChannels(userId); broadcastChannels(recipient.id);
      broadcastInvitations(userId); broadcastInvitations(recipient.id); broadcastPresence();
      if (conversation.changed) void resetMediaRoom(conversation.channelId);
      return res.json({ channel: getChannel(conversation.channelId, userId), invitation: null, requiresAcceptance: false });
    }
    const [firstId, secondId] = [userId, recipient.id].sort();
    let channelId, invitationId, incoming = false, created = false, membershipChanged = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      let pair = db.prepare('SELECT channel_id FROM direct_conversations WHERE first_user_id = ? AND second_user_id = ?').get(firstId, secondId);
      const now = clock();
      if (!pair) {
        channelId = randomUUID();
        db.prepare("INSERT INTO channels (id, name, description, created_at, owner_id, kind) VALUES (?, ?, '', ?, NULL, 'direct')").run(channelId, `direct:${channelId}`, now);
        db.prepare('INSERT INTO direct_conversations (channel_id, first_user_id, second_user_id) VALUES (?, ?, ?)').run(channelId, firstId, secondId);
        pair = { channel_id: channelId };
        created = true;
      }
      channelId = pair.channel_id;
      db.prepare("UPDATE channel_invitations SET status = 'expired' WHERE channel_id = ? AND status = 'pending' AND expires_at <= ?").run(channelId, now);
      // A crossed request opens the existing invitation for an explicit answer.
      const pendingIncoming = db.prepare("SELECT id FROM channel_invitations WHERE channel_id = ? AND recipient_id = ? AND status = 'pending'").get(channelId, userId);
      if (!hasMembership(channelId, userId) && pendingIncoming) {
        invitationId = pendingIncoming.id;
        incoming = true;
      } else {
        membershipChanged = db.prepare("INSERT OR IGNORE INTO memberships (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(channelId, userId, now).changes === 1;
        if (membershipChanged && !created) rotateMediaKey(channelId);
        if (!hasMembership(channelId, recipient.id)) {
          const pending = db.prepare("SELECT id FROM channel_invitations WHERE channel_id = ? AND recipient_id = ? AND status = 'pending'").get(channelId, recipient.id);
          invitationId = pending?.id || randomUUID();
          if (!pending) db.prepare("INSERT INTO channel_invitations (id, channel_id, created_by, recipient_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(invitationId, channelId, userId, recipient.id, now, now + INVITATION_MS);
        }
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    broadcastChannels(userId);
    broadcastInvitations(recipient.id);
    broadcastPresence();
    if (membershipChanged && !created) void resetMediaRoom(channelId);
    const invitation = invitationId ? publicInvitation(invitationById(invitationId, incoming ? userId : recipient.id)) : null;
    res.status(created ? 201 : 200).json({ channel: incoming ? null : getChannel(channelId, userId), invitation, requiresAcceptance: incoming });
  });
  app.get('/api/channels/:id/members', requireAuth, (req, res) => {
    getChannel(req.params.id, req.auth.user.id);
    res.json({ members: listMembers(req.params.id) });
  });
  app.get('/api/invitations', requireAuth, (req, res) => res.json({ invitations: listInvitations(req.auth.user.id) }));
  app.post('/api/channels/:id/invitations', requireAuth, (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    requireGroupChannel(channel);
    if (!['owner', 'admin'].includes(channel.role)) throw new HttpError(403, 'Приглашать участников может администратор канала.');
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().replace(/^@/, '').toLowerCase() : '';
    if (!USERNAME.test(username)) throw new HttpError(400, 'Укажите имя пользователя: 3–32 латинские буквы, цифры, дефис или подчёркивание.');
    const recipient = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!recipient) throw new HttpError(404, 'Пользователь не найден.');
    if (recipient.id === req.auth.user.id) throw new HttpError(400, 'Нельзя пригласить себя.');
    let invitationId, created = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (hasMembership(channel.id, recipient.id)) throw new HttpError(409, 'Пользователь уже состоит в канале.');
      assertNotBanned(channel.id, recipient.id);
      const now = clock();
      db.prepare("UPDATE channel_invitations SET status = 'expired' WHERE channel_id = ? AND recipient_id = ? AND status = 'pending' AND expires_at <= ?").run(channel.id, recipient.id, now);
      const pending = db.prepare("SELECT id FROM channel_invitations WHERE channel_id = ? AND recipient_id = ? AND status = 'pending'").get(channel.id, recipient.id);
      if (pending) invitationId = pending.id;
      else {
        invitationId = randomUUID();
        db.prepare("INSERT INTO channel_invitations (id, channel_id, created_by, recipient_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(invitationId, channel.id, req.auth.user.id, recipient.id, now, now + INVITATION_MS);
        created = true;
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const invitation = publicInvitation(invitationById(invitationId, recipient.id));
    broadcastInvitations(recipient.id);
    res.status(created ? 201 : 200).json({ invitation });
  });
  app.post('/api/invitations/:id/respond', requireAuth, async (req, res) => {
    const action = req.body?.action;
    if (action !== 'accept' && action !== 'decline') throw new HttpError(400, 'Выберите accept или decline.');
    const decision = action === 'accept' ? 'accepted' : 'declined';
    let row, membershipChanged = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      row = invitationById(req.params.id, req.auth.user.id);
      if (!row) throw new HttpError(404, 'Приглашение не найдено.');
      assertNotBanned(row.channel_id, req.auth.user.id);
      if (row.status !== 'pending') {
        if (row.status !== decision) throw new HttpError(409, row.status === 'expired' ? 'Срок приглашения истёк.' : 'На приглашение уже дан другой ответ.');
      } else {
        if (row.expires_at <= clock()) throw new HttpError(409, 'Срок приглашения истёк.');
        if (decision === 'accepted') {
          if (row.channel_kind === 'direct') {
            const pair = db.prepare('SELECT first_user_id, second_user_id FROM direct_conversations WHERE channel_id = ?').get(row.channel_id);
            if (!pair || ![pair.first_user_id, pair.second_user_id].includes(req.auth.user.id) || ![pair.first_user_id, pair.second_user_id].includes(row.created_by)) throw new HttpError(403, 'Это приглашение не предназначено для вашего аккаунта.');
          }
          membershipChanged = communities.grantMembership(row.channel_id, req.auth.user.id);
        }
        db.prepare('UPDATE channel_invitations SET status = ?, responded_at = ? WHERE id = ?').run(decision, clock(), row.id);
      }
      row = invitationById(row.id, req.auth.user.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    broadcastInvitations(req.auth.user.id);
    if (decision === 'accepted') {
      broadcastChannels();
      broadcastPresence();
      if (membershipChanged) await communities.resetMembershipRooms(row.channel_id);
      return res.json({ invitation: publicInvitation(row), channel: getChannel(row.channel_id, req.auth.user.id) });
    }
    res.json({ invitation: publicInvitation(row) });
  });
  app.post('/api/channels/:id/invites', requireAuth, (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    requireGroupChannel(channel);
    if (!['owner', 'admin'].includes(channel.role)) throw new HttpError(403, 'Приглашать участников может администратор канала.');
    enforceRate(`invites:${req.auth.user.id}`, 10, 60_000);
    const { maxUses = 10, expiresInHours = 168 } = req.body || {};
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100 || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) throw new HttpError(400, 'Приглашение: 1–100 использований, срок 1–720 часов.');
    const code = randomBytes(24).toString('base64url');
    const expiresAt = clock() + expiresInHours * 60 * 60_000;
    db.prepare('INSERT INTO invites (code_hash, created_by, max_uses, expires_at, channel_id) VALUES (?, ?, ?, ?, ?)').run(tokenHash(code), req.auth.user.id, maxUses, expiresAt, channel.id);
    res.status(201).json({ code, expiresAt: new Date(expiresAt).toISOString(), maxUses, channel: { id: channel.id, name: channel.name } });
  });
  app.get('/api/invites/:code', (req, res) => {
    const invite = getInvite(req.params.code);
    if (req.auth) assertNotBanned(invite.channel_id, req.auth.user.id);
    res.json({ channel: { id: invite.channel_id, name: invite.channel_name }, expiresAt: new Date(Number(invite.expires_at)).toISOString(), valid: invite.expires_at > clock() && invite.uses < invite.max_uses });
  });
  app.post('/api/invites/:code/join', requireAuth, async (req, res) => {
    enforceRate(`invite-join:${req.auth.user.id}`, 30, 60_000);
    const invite = getInvite(req.params.code);
    let membershipChanged = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      assertNotBanned(invite.channel_id, req.auth.user.id);
      if (!hasMembership(invite.channel_id, req.auth.user.id)) {
        const update = db.prepare('UPDATE invites SET uses = uses + 1 WHERE code_hash = ? AND expires_at > ? AND uses < max_uses').run(invite.code_hash, clock());
        if (update.changes !== 1) throw new HttpError(400, 'Приглашение истекло или уже использовано.');
        membershipChanged = communities.grantMembership(invite.channel_id, req.auth.user.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const channel = getChannel(invite.channel_id, req.auth.user.id);
    broadcastChannels(req.auth.user.id);
    broadcastPresence();
    if (membershipChanged) await communities.resetMembershipRooms(invite.channel_id);
    res.json({ channel });
  });
  app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
    getChannel(req.params.id, req.auth.user.id);
    const before = req.query.before;
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,14}$/.test(before))) throw new HttpError(400, 'Некорректный указатель сообщений.');
    const rows = before
      ? db.prepare(`${selectMessage} WHERE messages.channel_id = ? AND messages.deleted_at IS NULL AND messages.id < ? ORDER BY messages.id DESC LIMIT 51`).all(req.params.id, Number(before))
      : db.prepare(`${selectMessage} WHERE messages.channel_id = ? AND messages.deleted_at IS NULL ORDER BY messages.id DESC LIMIT 51`).all(req.params.id);
    res.json({ messages: rows.slice(0, 50).reverse().map(messageFromRow), hasMore: rows.length > 50 });
  });
  app.post('/api/channels/:id/messages', requireAuth, (req, res) => {
    getChannel(req.params.id, req.auth.user.id);
    enforceRate(`messages:${req.auth.user.id}`, 30, 60_000);
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim() || content.trim().length > 4000) throw new HttpError(400, 'Сообщение должно содержать от 1 до 4000 символов.');
    const result = db.prepare('INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)').run(req.params.id, req.auth.user.id, content.trim(), clock());
    const message = messageFromRow(db.prepare(`${selectMessage} WHERE messages.id = ?`).get(result.lastInsertRowid));
    broadcastMessage(message);
    res.status(201).json({ message });
  });
  app.post('/api/channels/:id/join', requireAuth, async (req, res) => {
    const channel = getChannel(req.params.id, req.auth.user.id);
    if (channel.channelType === 'text' && !channel.legacyVoiceCompatible) throw new HttpError(400, 'Для звонка выберите голосовой канал.');
    enforceRate(`join:${req.auth.user.id}`, 20, 60_000);
    if (req.body?.encryptionVersion !== 1) throw new HttpError(426, 'Обновите приложение или страницу: для звонков требуется поддержка шифрования версии 1.');
    if (!media.configured) throw new HttpError(503, 'Голос и видео ещё не настроены. Администратору нужно указать параметры LiveKit.');
    getMediaKey(channel.id);
    if (!await resetMediaRoom(channel.id)) throw new HttpError(503, 'Не удалось обновить защищённую комнату. Повторите подключение.');
    // Membership and key generation are re-read after any awaited room reset.
    const joinedChannel = getChannel(channel.id, req.auth.user.id);
    const key = getMediaKey(channel.id);
    let credentials;
    try { credentials = await media.join({ ...joinedChannel, encryptionEpoch: String(key.epoch) }, req.auth.user); }
    catch (error) {
      if (error.status === 409) throw error;
      throw new HttpError(503, 'Медиасервер недоступен. Проверьте LiveKit, его адрес и открытые UDP-порты.');
    }
    // A logout or expiry while awaiting the SFU must not issue a new media grant.
    if (!sessionUser(req)) throw new HttpError(401, 'Сессия завершена. Войдите снова.');
    const current = getChannel(channel.id, req.auth.user.id);
    const currentKey = getMediaKey(channel.id);
    if (current.muted !== joinedChannel.muted || currentKey.epoch !== key.epoch || currentKey.reset_pending) throw new HttpError(409, 'Состав или права комнаты изменились. Подключитесь повторно.');
    res.json({ ...credentials, encryption: { required: true, key: key.key, epoch: String(key.epoch), algorithm: 'AES-GCM', keyDerivation: 'PBKDF2' } });
  });
  app.get('/api/status', requireAuth, async (req, res) => {
    if (!media.configured) return res.json({ rooms: [], maxParticipants: MAX_PARTICIPANTS, mediaConfigured: false });
    try {
      const channels = listChannels(req.auth.user.id);
      const visibleIds = new Set(channels.map((channel) => channel.id));
      const returnedRooms = channels.length ? await media.status(channels) : [];
      if (!sessionUser(req)) throw new HttpError(401, 'Сессия завершена. Войдите снова.');
      const currentVisibleIds = new Set(listChannels(req.auth.user.id).map((channel) => channel.id));
      const roomState = returnedRooms.filter((room) => visibleIds.has(room.id) && currentVisibleIds.has(room.id));
      const accountName = db.prepare('SELECT username FROM users WHERE id = ?');
      const rooms = roomState.map((room) => ({
        id: room.id,
        participants: room.participants.map((participant) => {
          const username = accountName.get(participant.id)?.username || 'Участник';
          return { id: participant.id, username, displayName: username };
        }),
      }));
      res.json({ rooms, maxParticipants: MAX_PARTICIPANTS, mediaConfigured: true });
    }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'Не удалось получить состояние медиасервера. Проверьте LiveKit.'); }
  });
  communities.installRoutes();
  const moderationRoutes = installModerationRoutes(app, { db, clock, media, HttpError, requireAuth, sessionUser, getChannel, listMembers, broadcastChannels, broadcastInvitations, broadcastPresence, notifyModeration, rotateMediaKey, resetMediaRoom, scopedChannelIds: communities.scopedChannelIds });
  installMessageTools({ app, db, requireAuth, getChannel, clock, broadcastToChannel, HttpError });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Метод API не найден.' }));

  const dist = options.staticDir || resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h', dotfiles: 'deny', setHeaders(res, filePath) {
      if (/\/downloads\/(?:android\/)?latest\.json$/.test(filePath.replace(/\\/g, '/'))) res.setHeader('Cache-Control', 'no-store');
    } }));
    app.get('/{*path}', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(resolve(dist, 'index.html')); });
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error.status) || (error.type === 'entity.too.large' ? 413 : 500);
    const message = status === 500 ? 'Внутренняя ошибка сервера.' : error.type === 'entity.parse.failed' ? 'Некорректный JSON.' : error.message;
    if (status >= 500 && !(error instanceof HttpError)) console.error('Ошибка запроса:', error.name, error.code || '');
    res.status(status).json({ error: message });
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/api/ws' || !originAllowed(req)) throw new HttpError(403, 'Forbidden');
      enforceRate(`ws:${req.socket.remoteAddress}`, 30, 60_000);
      const auth = sessionUser(req);
      if (!auth) throw new HttpError(401, 'Unauthorized');
      if (sockets.size >= 100 || [...sockets.values()].filter((s) => s.user.id === auth.user.id).length >= 5) throw new HttpError(429, 'Too Many Requests');
      wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req, auth); });
    } catch (error) {
      const status = error.status || 400;
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  wss.on('connection', (ws, req, auth) => {
    ws.isAlive = true;
    sockets.set(ws, auth);
    ws.on('pong', () => { ws.isAlive = true; });
    // Clients send messages through the validated HTTP endpoint only.
    ws.on('message', () => ws.close(1008, 'Используйте HTTP API'));
    ws.on('error', () => {});
    ws.on('close', () => { sockets.delete(ws); broadcastPresence(); });
    sendClient(ws, auth, { type: 'channels', channels: listChannels(auth.user.id) });
    sendClient(ws, auth, { type: 'invitations', invitations: listInvitations(auth.user.id) });
    sendClient(ws, auth, { type: 'workspaces', workspaces: communities.listWorkspaces(auth.user.id) });
    sendClient(ws, auth, { type: 'friends', ...communities.listFriends(auth.user.id) });
    sendClient(ws, auth, { type: 'direct-calls', calls: communities.listCalls(auth.user.id) });
    broadcastPresence();
  });
  const heartbeat = setInterval(() => {
    for (const [ws, auth] of sockets) {
      if (!ws.isAlive || auth.expiresAt <= clock()) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const mediaResetTimer = setInterval(() => { void drainMediaResets().catch(() => {}); }, 5000);
  mediaResetTimer.unref();
  void drainMediaResets().catch(() => {});

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearInterval(mediaResetTimer);
    communities.close();
    for (const ws of sockets.keys()) ws.terminate();
    await new Promise((resolveClose) => wss.close(resolveClose));
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await moderationRoutes.close();
    await Promise.allSettled([...mediaResets.values()]);
    db.close();
  }
  syncMediaUsernames();
  return { app, server, db, close };
}
