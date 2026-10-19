import { readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';

export const deployDir = dirname(fileURLToPath(import.meta.url));

export function validateSettings(values) {
  const e = { ...values };
  e.TLS_MODE ??= 'domain';
  if (!['ip', 'domain'].includes(e.TLS_MODE)) throw new Error('TLS_MODE: ip или domain.');
  const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  for (const key of e.TLS_MODE === 'domain' ? ['APP_DOMAIN', 'RTC_DOMAIN'] : []) {
    if (!domain.test(e[key] ?? '') || /(?:^|\.)(?:example\.(?:com|net|org)|localhost|local|internal)$/.test(e[key])) {
      throw new Error(`${key}: нужен настоящий публичный домен в нижнем регистре, без схемы и порта.`);
    }
  }
  if (e.TLS_MODE === 'domain' && e.APP_DOMAIN === e.RTC_DOMAIN) throw new Error('APP_DOMAIN и RTC_DOMAIN должны различаться.');
  if (e.TLS_MODE === 'ip') { e.APP_DOMAIN = ''; e.RTC_DOMAIN = ''; }
  if (isIP(e.SERVER_IP ?? '') !== 4) throw new Error('SERVER_IP: нужен публичный IPv4 сервера.');
  const ip = e.SERVER_IP.split('.').map(Number);
  if (ip[0] === 0 || ip[0] === 10 || ip[0] === 127 || ip[0] >= 224 ||
      (ip[0] === 169 && ip[1] === 254) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
      (ip[0] === 192 && ip[1] === 168) || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127) ||
      (ip[0] === 192 && ip[1] === 0 && ip[2] === 2) ||
      (ip[0] === 198 && ip[1] === 51 && ip[2] === 100) ||
      (ip[0] === 203 && ip[1] === 0 && ip[2] === 113)) {
    throw new Error('SERVER_IP не должен быть локальным или документальным адресом.');
  }
  const port = Number(e.HTTPS_PORT ?? 8443);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3000, 3478, 7880, 7881, 7882, 7883].includes(port)) {
    throw new Error('HTTPS_PORT: выберите свободный порт 1024–65535, отличный от портов приложения и RTC.');
  }
  e.HTTPS_PORT = String(port);
  e.ACME_EMAIL ??= '';
  if (e.ACME_EMAIL && !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e.ACME_EMAIL)) {
    throw new Error('ACME_EMAIL: укажите корректную почту владельца либо оставьте поле пустым.');
  }
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(e.ADMIN_USERNAME ?? '')) throw new Error('ADMIN_USERNAME: 3–32 латинских букв, цифр, _ или -.');
  for (const key of ['ADMIN_PASSWORD', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(e[key] ?? '') || /GENERATE|CHANGE|example/i.test(e[key])) {
      throw new Error(`${key}: используйте generate-env.mjs для генерации секретов.`);
    }
  }
  e.TURN_ENABLED ??= 'false';
  if (!['true', 'false'].includes(e.TURN_ENABLED)) throw new Error('TURN_ENABLED: true или false.');
  return e;
}

export function readSettings(path = join(deployDir, '.env')) {
  return validateSettings(parseEnv(readFileSync(path, 'utf8')));
}

export function writePrivate(path, content) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export async function checkDns(e) {
  if (e.TLS_MODE === 'ip') return;
  for (const host of [e.APP_DOMAIN, e.RTC_DOMAIN]) {
    const ipv4 = await resolve4(host);
    if (!ipv4.length || ipv4.some(ip => ip !== e.SERVER_IP)) throw new Error(`DNS ${host}: все A записи должны указывать на SERVER_IP. Отключите DNS proxy/CDN.`);
    let ipv6;
    try { ipv6 = await resolve6(host); } catch (error) {
      if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) throw error;
      ipv6 = [];
    }
    if (ipv6.length) throw new Error(`DNS ${host}: базовая конфигурация рассчитана на IPv4. Удалите AAAA или настройте и проверьте IPv6 отдельно.`);
  }
}

export function render(e, options = {}) {
  const generated = options.outputDir ?? join(deployDir, 'generated');
  const directoryMode = options.directoryMode ?? 0o700;
  mkdirSync(generated, { recursive: true, mode: directoryMode });
  chmodSync(generated, directoryMode);
  const appHost = e.TLS_MODE === 'ip' ? e.SERVER_IP : e.APP_DOMAIN;
  const rtcHost = e.TLS_MODE === 'ip' ? e.SERVER_IP : e.RTC_DOMAIN;
  const appOrigin = `https://${appHost}:${e.HTTPS_PORT}`;
  const publicRtc = `wss://${rtcHost}:${e.HTTPS_PORT}`;
  const appEnv = {
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3000', DATA_DIR: options.dataDir ?? '/data',
    PUBLIC_URL: appOrigin, APP_ORIGIN: appOrigin, TRUST_PROXY: '1',
    LIVEKIT_URL: 'http://127.0.0.1:7880', LIVEKIT_PUBLIC_URL: publicRtc,
    ADMIN_USERNAME: e.ADMIN_USERNAME, ADMIN_PASSWORD: e.ADMIN_PASSWORD,
    LIVEKIT_API_KEY: e.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: e.LIVEKIT_API_SECRET,
  };
  writePrivate(join(generated, 'app.env'), Object.entries(appEnv).map(([key, value]) => `${key}=${value}\n`).join(''));
  const turn = e.TURN_ENABLED === 'true'
    ? `turn:\n  enabled: true\n  domain: ${rtcHost}\n  udp_port: 3478\n  tls_port: 0\n  relay_range_start: 30000\n  relay_range_end: 30100\n  per_user_relay_allocation_limit: 4\n`
    : 'turn:\n  enabled: false\n';
  writePrivate(join(generated, 'livekit.yaml'), `# Generated for LiveKit v1.13.10. Do not publish: contains a private key.\nport: 7880\nbind_addresses:\n  - 127.0.0.1\nrtc:\n  tcp_port: 7881\n  udp_port: 7882-7883\n  use_external_ip: false\n  node_ip: ${e.SERVER_IP}\n  congestion_control:\n    enabled: true\nroom:\n  auto_create: false\n  max_participants: 10\n  empty_timeout: 300\n  departure_timeout: 20\nkeys:\n  ${e.LIVEKIT_API_KEY}: ${e.LIVEKIT_API_SECRET}\nlogging:\n  level: warn\n  pion_level: error\n${turn}`);
  const globals = `# Generated for Caddy 2.11.7; owns only TCP80 and TCP${e.HTTPS_PORT}.\n{\n  admin off\n${e.ACME_EMAIL ? `  email ${e.ACME_EMAIL}\n` : ''}  http_port 80\n  https_port ${e.HTTPS_PORT}\n  servers {\n    protocols h1 h2\n  }\n}\n\n(public_tls) {\n  tls {\n    issuer acme https://acme-v02.api.letsencrypt.org/directory {\n${e.TLS_MODE === 'ip' ? '      profile shortlived\n' : ''}      disable_tlsalpn_challenge\n    }\n  }\n}\n\n`;
  const headers = `  header {\n    X-Content-Type-Options nosniff\n    Referrer-Policy same-origin\n    X-Frame-Options DENY\n  }\n`;
  const denyInternal = `  @internal path /internal/*\n  handle @internal {\n    respond 404\n  }\n`;
  const rtcRoutes = `  @livekitSignal path /rtc /rtc/*\n  handle @livekitSignal {\n    forward_auth 127.0.0.1:3000 {\n      uri /internal/media-access\n      header_up -Connection\n      header_up -Upgrade\n    }\n    reverse_proxy 127.0.0.1:7880\n  }\n  @livekitApi path /twirp/*\n  handle @livekitApi {\n    reverse_proxy 127.0.0.1:7880\n  }\n`;
  const sites = e.TLS_MODE === 'ip'
    ? `https://${appHost}:${e.HTTPS_PORT} {\n  import public_tls\n  encode zstd gzip\n${headers}${denyInternal}${rtcRoutes}  handle {\n    reverse_proxy 127.0.0.1:3000\n  }\n}\n`
    : `https://${appHost}:${e.HTTPS_PORT} {\n  import public_tls\n  encode zstd gzip\n${headers}${denyInternal}  handle {\n    reverse_proxy 127.0.0.1:3000\n  }\n}\n\nhttps://${rtcHost}:${e.HTTPS_PORT} {\n  import public_tls\n${denyInternal}${rtcRoutes}  handle {\n    respond 404\n  }\n}\n`;
  writePrivate(join(generated, 'Caddyfile'), globals + sites);
  return appOrigin;
}
