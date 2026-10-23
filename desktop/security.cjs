'use strict';

const path = require('node:path');

const SERVER_ORIGIN = 'https://13.143.172.92:9443';
const SERVER_WEBSOCKET = 'wss://13.143.172.92:9443/api/ws';
const APP_URL = 'app://signal/index.html';
const PICKER_URL = 'app://picker/index.html';
const ID = '[A-Za-z0-9_-]{1,100}';

function isAppUrl(value, host = 'signal') {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === host && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function apiTarget(value, method) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/api/') || value.includes('\\') || value.split('?')[0].includes('%') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Недопустимый адрес API.');
  const url = new URL(value, SERVER_ORIGIN);
  if (url.origin !== SERVER_ORIGIN || url.hash || url.username || url.password) throw new Error('Недопустимый адрес API.');
  const pathname = url.pathname;
  let permitted = false;
  if (method === 'GET') {
    permitted = /^\/api\/(health|config|me|channels|status|invitations|workspaces|friends|direct-calls)$/.test(pathname)
      || new RegExp(`^/api/invites/${ID}$`).test(pathname)
      || new RegExp(`^/api/channels/${ID}/(members|bans|pins)$`).test(pathname);
    if (pathname === '/api/search') {
      permitted = [...url.searchParams.keys()].every(key => ['q', 'channelId', 'before'].includes(key))
        && ['q', 'channelId', 'before'].every(key => url.searchParams.getAll(key).length <= 1);
      const query = url.searchParams.get('q'), channelId = url.searchParams.get('channelId'), before = url.searchParams.get('before');
      if (query === null || query.trim().length < 2 || query.trim().length > 100
        || (channelId !== null && !new RegExp(`^${ID}$`).test(channelId))
        || (before !== null && !/^[1-9]\d{0,14}$/.test(before))) permitted = false;
    } else if (new RegExp(`^/api/channels/${ID}/messages$`).test(pathname)) {
      permitted = [...url.searchParams.keys()].every((key) => key === 'before') && url.searchParams.getAll('before').length <= 1;
      const before = url.searchParams.get('before');
      if (before !== null && !/^[1-9]\d{0,14}$/.test(before)) permitted = false;
    } else if (url.search) permitted = false;
  } else if (method === 'POST' && !url.search) {
    permitted = /^\/api\/(login|register|logout|channels|direct-channels|workspaces|friend-requests|direct-calls)$/.test(pathname)
      || pathname === '/api/account/password'
      || new RegExp(`^/api/workspaces/${ID}/channels$`).test(pathname)
      || new RegExp(`^/api/friend-requests/${ID}/respond$`).test(pathname)
      || new RegExp(`^/api/friends/${ID}/remove$`).test(pathname)
      || new RegExp(`^/api/direct-calls/${ID}/respond$`).test(pathname)
      || new RegExp(`^/api/channels/${ID}/(messages|join|invites|invitations|settings|leave|delete)$`).test(pathname)
      || new RegExp(`^/api/channels/${ID}/members/${ID}$`).test(pathname)
      || new RegExp(`^/api/channels/${ID}/messages/[1-9]\\d{0,14}/action$`).test(pathname)
      || new RegExp(`^/api/invitations/${ID}/respond$`).test(pathname)
      || new RegExp(`^/api/invites/${ID}/join$`).test(pathname);
  }
  if (!permitted) throw new Error('Этот метод API недоступен приложению.');
  return url.href;
}

function inviteCode(value) {
  try {
    if (typeof value !== 'string' || value.length > 200) return null;
    const url = new URL(value);
    if (url.protocol !== 'signal:' || url.hostname !== 'invite' || url.port || url.username || url.password || url.search || url.hash) return null;
    const code = url.pathname.slice(1);
    return /^[A-Za-z0-9_-]{8,100}$/.test(code) ? code : null;
  } catch { return null; }
}

function assetPath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) return null;
  const target = path.resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

function isServerNetwork(value) {
  try {
    const url = new URL(value);
    return ['https:', 'wss:'].includes(url.protocol) && url.hostname === '13.143.172.92' && url.port === '9443' && !url.username && !url.password;
  } catch { return false; }
}

module.exports = { SERVER_ORIGIN, SERVER_WEBSOCKET, APP_URL, PICKER_URL, isAppUrl, apiTarget, inviteCode, assetPath, isServerNetwork };
