import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.mjs';
import { createMedia, MAX_PARTICIPANTS } from '../server/media.mjs';

const ADMIN_PASSWORD = 'Local-test-password-8931';
const USER_PASSWORD = 'Member-test-password-6947';
const TEST_ORIGIN = 'http://signal.test';
const baseEnv = { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD, APP_ORIGIN: TEST_ORIGIN };

async function temporaryDirectory() { return mkdtemp(join(tmpdir(), 'signal-tests-')); }
async function removeTemporaryDirectory(directory) {
  const target = resolve(directory);
  assert.ok(target.startsWith(resolve(tmpdir(), 'signal-tests-')), 'Cleanup must stay in the test directory');
  await rm(target, { recursive: true, force: true });
}
async function listen(service) {
  await new Promise((resolveListen, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolveListen); });
  return `http://127.0.0.1:${service.server.address().port}`;
}
async function request(base, path, { method = 'GET', body, cookie, origin = TEST_ORIGIN, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}),
  });
  const content = response.status === 204 ? null : await response.json();
  return { status: response.status, content, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
async function rejectedWebSocket(base, headers) {
  return new Promise((resolveReject, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws`, { headers });
    ws.on('unexpected-response', (req, response) => { response.resume(); ws.terminate(); resolveReject(response.statusCode); });
    ws.on('open', () => { ws.terminate(); reject(new Error('The unauthorized WebSocket was accepted')); });
    ws.on('error', () => {});
  });
}

describe('durable authenticated chat API', { concurrency: false }, () => {
  let directory, service, base, adminCookie, memberCookie, member, inviteCode, outsiderCookie;
  let now = Date.now();
  const mediaCalls = [];
  const fakeMedia = {
    configured: true,
    async join(channel, user) { mediaCalls.push({ channel, user }); return { url: 'wss://rtc.test', token: 'short-test-token' }; },
    async status() { return [{ id: 'general', participants: [{ id: member?.id || 'id', displayName: 'Тест' }] }]; },
  };
  before(async () => {
    directory = await temporaryDirectory();
    service = await createApp({ env: baseEnv, dataDir: directory, clock: () => now, media: fakeMedia });
    base = await listen(service);
  });
  after(async () => { await service?.close(); if (directory) await removeTemporaryDirectory(directory); });

  test('public endpoints disclose no credentials and protected routes require a session', async () => {
    const config = await request(base, '/api/config');
    assert.deepEqual(config.content, { name: 'Сигнал', maxParticipants: 10, mediaConfigured: true });
    assert.deepEqual((await request(base, '/api/me')).content, { user: null });
    assert.equal((await request(base, '/api/channels')).status, 401);
    assert.equal((await request(base, '/api/channels/general/messages')).status, 401);
    assert.equal((await request(base, '/api/channels/general/join', { method: 'POST' })).status, 401);
  });

  test('login rejects cross-origin requests, malformed bodies and wrong credentials', async () => {
    assert.equal((await request(base, '/api/login', { method: 'POST', origin: 'https://attacker.invalid', body: { username: 'owner', password: ADMIN_PASSWORD } })).status, 403);
    const withoutOrigin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: ADMIN_PASSWORD }) });
    assert.equal(withoutOrigin.status, 403);
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: [] } })).status, 400);
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: 'wrong' } })).status, 401);
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { username: "' OR 1=1 --", password: ADMIN_PASSWORD } })).status, 401);
  });

  test('passwords use salted scrypt and opaque session tokens are hashed at rest', async () => {
    const result = await request(base, '/api/login', { method: 'POST', body: { username: 'OWNER', password: ADMIN_PASSWORD } });
    assert.equal(result.status, 200);
    assert.equal(result.content.user.role, 'admin');
    assert.equal(Object.hasOwn(result.content.user, 'password_hash'), false);
    adminCookie = result.cookie;
    assert.match(result.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(result.headers.get('set-cookie'), /SameSite=Lax/i);
    const token = adminCookie.split('=')[1];
    const saved = service.db.prepare('SELECT * FROM sessions').get();
    assert.notEqual(saved.token_hash, token);
    assert.equal(saved.token_hash, createHash('sha256').update(token).digest('hex'));
    const row = service.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('owner');
    assert.match(row.password_hash, /^scrypt\$65536\$8\$1\$/);
    assert.ok(!row.password_hash.includes(ADMIN_PASSWORD));
    assert.equal((await request(base, '/api/me', { cookie: adminCookie })).content.user.username, 'owner');
  });

  test('accounts register without an invite and join only the invited channel', async () => {
    const invalid = await request(base, '/api/register', { method: 'POST', body: { username: 'invalid', displayName: 'Участник', password: 'short' } });
    assert.equal(invalid.status, 400);
    const registered = await request(base, '/api/register', { method: 'POST', body: { username: 'member', displayName: 'Участник', password: USER_PASSWORD } });
    assert.equal(registered.status, 201);
    memberCookie = registered.cookie;
    member = registered.content.user;
    assert.equal(member.role, 'member');
    assert.deepEqual((await request(base, '/api/channels', { cookie: memberCookie })).content.channels, []);
    assert.deepEqual((await request(base, '/api/status', { cookie: memberCookie })).content.rooms, []);
    assert.equal((await request(base, '/api/channels/general/messages', { cookie: memberCookie })).status, 404);
    assert.equal((await request(base, '/api/channels/general/messages', { method: 'POST', cookie: memberCookie, body: { content: 'Без доступа' } })).status, 404);
    assert.equal((await request(base, '/api/channels/general/join', { method: 'POST', cookie: memberCookie })).status, 404);
    const seeded = (await request(base, '/api/channels', { cookie: adminCookie })).content.channels;
    assert.deepEqual(seeded.map((channel) => channel.id), ['general', 'gaming', 'lounge']);
    assert.ok(seeded.every((channel) => channel.role === 'owner'));
    assert.equal((await request(base, '/api/invites', { method: 'POST', cookie: adminCookie })).status, 404);
    const invite = await request(base, '/api/channels/general/invites', { method: 'POST', cookie: adminCookie, body: { maxUses: 1, expiresInHours: 1 } });
    assert.equal(invite.status, 201);
    inviteCode = invite.content.code;
    assert.equal(inviteCode.length, 32);
    assert.deepEqual(invite.content.channel, { id: 'general', name: 'Общий' });
    assert.equal(service.db.prepare('SELECT code_hash FROM invites').get().code_hash === inviteCode, false);
    const metadata = await request(base, `/api/invites/${inviteCode}`);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.content.valid, true);
    assert.deepEqual(Object.keys(metadata.content).sort(), ['channel', 'expiresAt', 'valid']);
    assert.equal((await request(base, `/api/invites/${inviteCode}/join`, { method: 'POST' })).status, 401);
    const joined = await request(base, `/api/invites/${inviteCode}/join`, { method: 'POST', cookie: memberCookie });
    assert.equal(joined.status, 200);
    assert.equal(joined.content.channel.role, 'member');
    assert.deepEqual((await request(base, '/api/channels', { cookie: memberCookie })).content.channels.map((channel) => channel.id), ['general']);
    assert.equal((await request(base, '/api/channels/general/invites', { method: 'POST', cookie: memberCookie })).status, 403);
    assert.equal((await request(base, `/api/invites/${inviteCode}`)).content.valid, false);
    assert.equal((await request(base, `/api/invites/${inviteCode}/join`, { method: 'POST', cookie: memberCookie })).status, 200);
    assert.equal(service.db.prepare('SELECT uses FROM invites WHERE code_hash = ?').get(createHash('sha256').update(inviteCode).digest('hex')).uses, 1);
  });

  test('invite use stays atomic across concurrent account joins; expiry and retries do not leak access', async () => {
    now += 60 * 60_000 + 1;
    const people = await Promise.all(['person1', 'person2'].map((username) => request(base, '/api/register', { method: 'POST', body: { username, displayName: username, password: USER_PASSWORD } })));
    assert.ok(people.every((person) => person.status === 201));
    const invite = await request(base, '/api/channels/general/invites', { method: 'POST', cookie: adminCookie, body: { maxUses: 1, expiresInHours: 1 } });
    const attempts = await Promise.all(people.map((person) => request(base, `/api/invites/${invite.content.code}/join`, { method: 'POST', cookie: person.cookie })));
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 400]);
    const loser = people[attempts.findIndex((attempt) => attempt.status === 400)];
    const winner = people[attempts.findIndex((attempt) => attempt.status === 200)];
    outsiderCookie = loser.cookie;
    assert.deepEqual((await request(base, '/api/channels', { cookie: outsiderCookie })).content.channels, []);
    assert.equal(service.db.prepare('SELECT uses FROM invites WHERE code_hash = ?').get(createHash('sha256').update(invite.content.code).digest('hex')).uses, 1);
    now += 60 * 60_000 + 1;
    assert.equal((await request(base, `/api/invites/${invite.content.code}/join`, { method: 'POST', cookie: winner.cookie })).status, 200);
    const expired = await request(base, '/api/channels/general/invites', { method: 'POST', cookie: adminCookie, body: { maxUses: 1, expiresInHours: 1 } });
    now += 60 * 60_000 + 1;
    assert.equal((await request(base, `/api/invites/${expired.content.code}`)).content.valid, false);
    assert.equal((await request(base, `/api/invites/${expired.content.code}/join`, { method: 'POST', cookie: outsiderCookie })).status, 400);
    assert.equal((await request(base, `/api/invites/${'x'.repeat(32)}/join`, { method: 'POST', cookie: outsiderCookie })).status, 404);
    assert.equal((await request(base, '/api/invites/not-a-code')).status, 404);
    assert.deepEqual((await request(base, '/api/channels', { cookie: outsiderCookie })).content.channels, []);
  });

  test('channels and messages validate length, persist text safely and paginate without duplication', async () => {
    const channel = await request(base, '/api/channels', { method: 'POST', cookie: adminCookie, body: { name: 'Команда', description: 'Здесь обсуждаем планы' } });
    assert.equal(channel.status, 201);
    assert.equal((await request(base, '/api/channels/missing/messages', { cookie: memberCookie })).status, 404);
    assert.equal((await request(base, '/api/channels/general/messages?before=1%20OR%201=1', { cookie: memberCookie })).status, 400);
    assert.equal((await request(base, '/api/channels/general/messages', { method: 'POST', cookie: memberCookie, body: { content: ' ' } })).status, 400);
    assert.equal((await request(base, '/api/channels/general/messages', { method: 'POST', cookie: memberCookie, body: { content: 'a'.repeat(4001) } })).status, 400);
    const content = '<script>alert(1)</script> Привет';
    const posted = await request(base, '/api/channels/general/messages', { method: 'POST', cookie: memberCookie, body: { content } });
    assert.equal(posted.status, 201);
    assert.equal(posted.content.message.content, content);
    assert.equal(posted.content.message.user.id, member.id);
    for (let i = 0; i < 51; i++) {
      if (i % 20 === 0) now += 60_001;
      assert.equal((await request(base, '/api/channels/general/messages', { method: 'POST', cookie: memberCookie, body: { content: `Сообщение ${i}` } })).status, 201);
    }
    const first = await request(base, '/api/channels/general/messages', { cookie: memberCookie });
    assert.equal(first.content.messages.length, 50);
    assert.equal(first.content.hasMore, true);
    const second = await request(base, `/api/channels/general/messages?before=${first.content.messages[0].id}`, { cookie: memberCookie });
    assert.equal(second.content.messages.length, 2);
    assert.equal(second.content.hasMore, false);
    assert.ok(second.content.messages.every((a) => !first.content.messages.some((b) => a.id === b.id)));
    assert.equal(second.content.messages[0].content, content);
  });

  test('WebSocket authenticates cookie, checks origin and broadcasts messages to authenticated clients', async () => {
    assert.equal(await rejectedWebSocket(base, { Origin: TEST_ORIGIN }), 401);
    assert.equal(await rejectedWebSocket(base, { Origin: 'https://attacker.invalid', Cookie: memberCookie }), 403);
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws`, { headers: { Origin: TEST_ORIGIN, Cookie: memberCookie } });
    await new Promise((resolveOpen, reject) => { ws.once('open', resolveOpen); ws.once('error', reject); });
    const received = new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => reject(new Error('No WebSocket message')), 3000);
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'message') { clearTimeout(timer); resolveMessage(event.message); }
      });
    });
    const result = await request(base, '/api/channels/general/messages', { method: 'POST', cookie: memberCookie, body: { content: 'WebSocket доставка' } });
    assert.equal((await received).id, result.content.message.id);
    ws.close();
    await new Promise((resolveClose) => ws.once('close', resolveClose));
  });

  test('join uses authenticated identity and status requires authentication', async () => {
    const result = await request(base, '/api/channels/general/join', { method: 'POST', cookie: memberCookie });
    assert.equal(result.status, 200);
    assert.equal(result.content.url, 'wss://rtc.test');
    assert.equal(mediaCalls.at(-1).user.id, member.id);
    assert.equal(mediaCalls.at(-1).channel.id, 'general');
    assert.equal((await request(base, '/api/status')).status, 401);
    assert.equal((await request(base, '/api/status', { cookie: memberCookie })).content.maxParticipants, 10);
  });

  test('oversize payloads are rejected and login attempts are rate limited', async () => {
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: 'a'.repeat(20_000) } })).status, 413);
    now += 15 * 60_000 + 1;
    for (let i = 0; i < 10; i++) assert.equal((await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: [] } })).status, 400);
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: ADMIN_PASSWORD } })).status, 429);
  });

  test('logout revokes the server session and persistent messages survive restart', async () => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws`, { headers: { Origin: TEST_ORIGIN, Cookie: memberCookie } });
    await new Promise((resolveOpen, reject) => { ws.once('open', resolveOpen); ws.once('error', reject); });
    const socketClosed = new Promise((resolveClose) => ws.once('close', (code) => resolveClose(code)));
    const result = await request(base, '/api/logout', { method: 'POST', cookie: memberCookie });
    assert.equal(result.status, 204);
    assert.equal(await socketClosed, 4001);
    assert.equal((await request(base, '/api/channels', { cookie: memberCookie })).status, 401);
    const userCount = service.db.prepare('SELECT count(*) AS total FROM users').get().total;
    await service.close();
    service = await createApp({ env: { ...baseEnv, ADMIN_PASSWORD: 'does-not-replace-existing-password' }, dataDir: directory, clock: () => now, media: fakeMedia });
    base = await listen(service);
    assert.equal(service.db.prepare('SELECT count(*) AS total FROM users').get().total, userCount);
    assert.ok(service.db.prepare('SELECT count(*) AS total FROM messages').get().total >= 53);
    const login = await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: ADMIN_PASSWORD } });
    assert.equal(login.status, 200);
    now += 8 * 24 * 60 * 60_000;
    assert.equal((await request(base, '/api/channels', { cookie: login.cookie })).status, 401);
  });
});

test('first launch has no default password and production requires an explicit HTTPS origin', async () => {
  const directory = await temporaryDirectory();
  try {
    await assert.rejects(createApp({ dataDir: directory, env: {} }), /Первый запуск/);
    await assert.rejects(createApp({ dataDir: directory, env: { ...baseEnv, NODE_ENV: 'production', APP_ORIGIN: '' } }), /APP_ORIGIN/);
    const service = await createApp({ dataDir: directory, env: { ...baseEnv, NODE_ENV: 'production', APP_ORIGIN: 'https://signal.test' }, media: { configured: false } });
    try {
      const base = await listen(service);
      const login = await request(base, '/api/login', { method: 'POST', origin: 'https://signal.test', body: { username: 'owner', password: ADMIN_PASSWORD } });
      assert.equal(login.status, 200);
      assert.match(login.headers.get('set-cookie'), /Secure/i);
      assert.deepEqual((await request(base, '/api/health')).content, { ok: true, mediaConfigured: false });
      const join = await request(base, '/api/channels/general/join', { method: 'POST', cookie: login.cookie, origin: 'https://signal.test' });
      assert.equal(join.status, 503);
      assert.match(join.content.error, /LiveKit/);
    } finally { await service.close(); }
  } finally { await removeTemporaryDirectory(directory); }
});

test('LiveKit room capacity is enforced by the SFU and JWT expires after five minutes', async () => {
  const calls = [];
  let participants = [];
  class FakeToken {
    constructor(key, secret, options) { calls.push({ type: 'token', key, secret, options }); }
    addGrant(grant) { calls.push({ type: 'grant', grant }); }
    async toJwt() { return 'test-jwt'; }
  }
  const rooms = {
    async createRoom(options) { calls.push({ type: 'room', options }); },
    async listParticipants() { return participants; },
    async listRooms() { return [{ name: 'general' }]; },
  };
  const media = createMedia({ LIVEKIT_API_KEY: 'testkey', LIVEKIT_API_SECRET: 'testsecret', LIVEKIT_PUBLIC_URL: 'wss://rtc.test' }, { rooms, AccessToken: FakeToken });
  const user = { id: 'opaque-user-id', displayName: 'Тест' };
  assert.deepEqual(await media.join({ id: 'general' }, user), { url: 'wss://rtc.test', token: 'test-jwt' });
  assert.equal(calls.find((c) => c.type === 'room').options.maxParticipants, MAX_PARTICIPANTS);
  assert.equal(calls.find((c) => c.type === 'token').options.ttl, '5m');
  assert.equal(calls.find((c) => c.type === 'token').options.identity, user.id);
  const grant = calls.find((c) => c.type === 'grant').grant;
  assert.equal(grant.room, 'general');
  assert.equal(grant.roomJoin, true);
  assert.equal(grant.canPublishSources.length, 4);
  assert.equal(grant.roomAdmin, undefined);
  participants = Array.from({ length: 10 }, (_, i) => ({ identity: `person-${i}`, name: `Участник ${i}` }));
  await assert.rejects(media.join({ id: 'general' }, user), (error) => error.status === 409);
  await assert.doesNotReject(media.join({ id: 'general' }, { id: 'person-1', displayName: 'Переподключение' }));
  assert.equal((await media.status([{ id: 'general' }]))[0].participants.length, 10);
});

test('LiveKit transport failures produce an actionable 503 without leaking server details', async () => {
  const directory = await temporaryDirectory();
  const service = await createApp({
    env: baseEnv, dataDir: directory,
    media: { configured: true, async join() { throw new Error('secret-key INTERNAL'); }, async status() { throw new Error('secret-key INTERNAL'); } },
  });
  try {
    const base = await listen(service);
    const auth = await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: ADMIN_PASSWORD } });
    const join = await request(base, '/api/channels/general/join', { method: 'POST', cookie: auth.cookie });
    assert.equal(join.status, 503);
    assert.match(join.content.error, /LiveKit/);
    assert.ok(!join.content.error.includes('secret-key'));
    assert.equal((await request(base, '/api/status', { cookie: auth.cookie })).status, 503);
  } finally { await service.close(); await removeTemporaryDirectory(directory); }
});

test('logout during a pending SFU join prevents a fresh token being delivered', { timeout: 10_000 }, async () => {
  const directory = await temporaryDirectory();
  let started, finish;
  const joining = new Promise((resolveStart) => { started = resolveStart; });
  const waiting = new Promise((resolveFinish) => { finish = resolveFinish; });
  const service = await createApp({
    env: baseEnv, dataDir: directory,
    media: {
      configured: true,
      async join() { started(); await waiting; return { url: 'wss://rtc.test', token: 'must-never-be-delivered' }; },
      async status() { return []; },
    },
  });
  try {
    const base = await listen(service);
    const auth = await request(base, '/api/login', { method: 'POST', body: { username: 'owner', password: ADMIN_PASSWORD } });
    const pendingJoin = request(base, '/api/channels/general/join', { method: 'POST', cookie: auth.cookie });
    await joining;
    assert.equal((await request(base, '/api/logout', { method: 'POST', cookie: auth.cookie })).status, 204);
    finish();
    const result = await pendingJoin;
    assert.equal(result.status, 401);
    assert.equal(Object.hasOwn(result.content, 'token'), false);
  } finally { finish(); await service.close(); await removeTemporaryDirectory(directory); }
});
