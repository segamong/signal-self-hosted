import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render, validateSettings } from '../deploy/config.mjs';

const require = createRequire(import.meta.url);
const { SERVER_ORIGIN, SERVER_WEBSOCKET, apiTarget, isServerNetwork } = require('../desktop/security.cjs');

test('desktop uses the domain while retaining a strict HTTPS/WSS allowlist', () => {
  assert.equal(SERVER_ORIGIN, 'https://signal-on.ru');
  assert.equal(SERVER_WEBSOCKET, 'wss://signal-on.ru/api/ws');
  assert.equal(apiTarget('/api/me', 'GET'), 'https://signal-on.ru/api/me');
  assert.equal(apiTarget('/api/channels/test-room/join', 'POST'), 'https://signal-on.ru/api/channels/test-room/join');
  for (const url of ['https://signal-on.ru/api/config', 'wss://signal-on.ru/rtc', 'https://signal-on.ru:443/downloads/latest.json']) {
    assert.equal(isServerNetwork(url), true, url);
  }
  for (const url of ['http://signal-on.ru', 'ws://signal-on.ru/rtc', 'https://signal-on.ru:9443',
    'https://signal-on.ru.attacker.test', 'https://signal-on.ru@attacker.test', 'https://user:password@signal-on.ru',
    'https://13.143.172.92:9443', 'https://177.3.212.182', 'file:///tmp/test']) {
    assert.equal(isServerNetwork(url), false, url);
  }
  assert.throws(() => apiTarget('//attacker.test/api/me', 'GET'));
});

test('generated media configuration binds ICE to the requested server IP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-origin-test-'));
  try {
    const secret = 'test-secret-abcdefghijklmnopqrstuvwxyz-012345';
    const settings = validateSettings({ TLS_MODE: 'ip', SERVER_IP: '8.8.8.8', HTTPS_PORT: '9443',
      ADMIN_USERNAME: 'test', ADMIN_PASSWORD: secret, LIVEKIT_API_KEY: secret, LIVEKIT_API_SECRET: secret });
    render(settings, { outputDir: directory });
    const media = await readFile(join(directory, 'livekit.yaml'), 'utf8');
    assert.match(media, /node_ip: 8\.8\.8\.8\n  ips:\n    includes:\n      - 8\.8\.8\.8\/32\n/);
    assert.match(media, /use_external_ip: false/);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), 'signal-origin-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});
