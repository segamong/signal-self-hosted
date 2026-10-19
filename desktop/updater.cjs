'use strict';

const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { SERVER_ORIGIN } = require('./security.cjs');

const MANIFEST_URL = `${SERVER_ORIGIN}/downloads/latest.json`;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

class UpdateError extends Error {}

function versionParts(value) {
  if (typeof value !== 'string' || !STABLE_VERSION.test(value)) throw new UpdateError('Сервер вернул некорректную версию обновления.');
  return value.split('.').map(Number);
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}
function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpdateError('Сервер вернул некорректное описание обновления.');
  versionParts(value.version);
  if (value.filename !== `Signal-Setup-${value.version}-x64.exe`
    || typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_INSTALLER_BYTES) throw new UpdateError('Описание обновления не прошло проверку.');
  return { version: value.version, filename: value.filename, sha256: value.sha256.toLowerCase(), size: value.size };
}

function createManualUpdater({ currentVersion, userData, emit, onInstallLaunched }) {
  let state = { status: 'idle', currentVersion };
  let manifest = null;
  let verifiedInstaller = null;
  let partialFile = null;
  let operation = null;
  let busy = false;
  let disposed = false;
  let cancelRequest = null;
  const updatesDirectory = path.resolve(userData, 'updates');

  const getState = () => ({ ...state });
  function publish(next) {
    state = { currentVersion, ...next };
    if (!disposed) emit(getState());
    return getState();
  }
  async function cleanupPartial() {
    const filename = partialFile; partialFile = null;
    if (filename) await fsp.unlink(filename).catch(() => {});
  }
  function withOperation(action) {
    if (busy || disposed) return Promise.resolve(getState());
    busy = true;
    operation = (async () => {
      try { return await action(); }
      catch (error) {
        await cleanupPartial();
        verifiedInstaller = null;
        return publish({ status: 'error', ...(manifest ? { version: manifest.version } : {}), error: error instanceof UpdateError ? error.message : 'Не удалось получить обновление. Проверьте интернет и свободное место, затем повторите попытку.' });
      } finally { busy = false; operation = null; }
    })();
    return operation;
  }

  function openResponse(url, maxBytes, totalTimeout) {
    // Both URLs are constructed here, never accepted from renderer or manifest.
    if (url !== MANIFEST_URL && (!manifest || url !== `${SERVER_ORIGIN}/downloads/${manifest.filename}`)) throw new UpdateError('Недопустимый адрес обновления.');
    return new Promise((resolve, reject) => {
      let totalTimer;
      let request;
      const dispose = () => { clearTimeout(totalTimer); if (cancelRequest === cancel) cancelRequest = null; request?.destroy(); };
      const fail = (error) => { dispose(); reject(error); };
      const cancel = () => request?.destroy(new UpdateError('Загрузка обновления прервана.'));
      try {
        request = https.get(url, {
          agent: false, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
          headers: { Accept: url === MANIFEST_URL ? 'application/json' : 'application/octet-stream', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': `Signal-Desktop/${currentVersion}` },
        }, (response) => {
          if (response.statusCode !== 200) { response.destroy(); return fail(new UpdateError(`Сервер обновлений вернул ошибку (${response.statusCode || 'нет ответа'}). Повторите позже.`)); }
          const encoding = response.headers['content-encoding'];
          if (encoding && encoding !== 'identity') { response.destroy(); return fail(new UpdateError('Сервер вернул неподдерживаемый формат обновления.')); }
          const contentLength = response.headers['content-length'];
          if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) { response.destroy(); return fail(new UpdateError('Размер ответа сервера превышает допустимый.')); }
          resolve({ response, dispose });
        });
        cancelRequest = cancel;
        request.setTimeout(20000, () => request.destroy(new UpdateError('Сервер обновлений не отвечает. Повторите попытку.')));
        totalTimer = setTimeout(() => request.destroy(new UpdateError('Истекло время загрузки обновления. Повторите попытку.')), totalTimeout);
        request.once('error', fail);
      } catch (error) { fail(error); }
    });
  }

  async function ensureDirectory() {
    await fsp.mkdir(updatesDirectory, { recursive: true, mode: 0o700 });
    const info = await fsp.lstat(updatesDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UpdateError('Папка обновлений недоступна. Переустановите приложение через Signal-Setup.');
  }
  function installerPath() {
    if (!manifest) throw new UpdateError('Сначала проверьте наличие обновлений.');
    const target = path.resolve(updatesDirectory, manifest.filename);
    if (path.dirname(target) !== updatesDirectory) throw new UpdateError('Недопустимое имя файла обновления.');
    return target;
  }
  async function verifyInstaller(filename) {
    const info = await fsp.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.size) throw new UpdateError('Размер установщика не совпал. Загрузите обновление заново.');
    const real = await fsp.realpath(filename);
    const realDirectory = await fsp.realpath(updatesDirectory);
    if (path.dirname(real) !== realDirectory) throw new UpdateError('Путь установщика не прошёл проверку.');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(filename)) {
      size += chunk.length;
      if (size > manifest.size) throw new UpdateError('Установщик изменился. Загрузите обновление заново.');
      hash.update(chunk);
    }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new UpdateError('Контрольная сумма установщика не совпала. Загрузите обновление заново.');
  }

  function checkUpdate() {
    return withOperation(async () => {
      if (process.platform !== 'win32') throw new UpdateError('Эта версия обновления предназначена для Windows 10/11.');
      manifest = null; verifiedInstaller = null;
      publish({ status: 'checking' });
      const { response, dispose } = await openResponse(MANIFEST_URL, MAX_MANIFEST_BYTES, 30000);
      let bytes = 0; const chunks = [];
      try {
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > MAX_MANIFEST_BYTES) throw new UpdateError('Описание обновления превышает допустимый размер.');
          chunks.push(chunk);
        }
      } finally { dispose(); }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new UpdateError('Сервер вернул некорректное описание обновления.'); }
      manifest = validateManifest(value);
      return publish({ status: compareVersions(manifest.version, currentVersion) > 0 ? 'available' : 'current', version: manifest.version });
    });
  }

  function downloadUpdate() {
    return withOperation(async () => {
      if (!manifest || compareVersions(manifest.version, currentVersion) <= 0) throw new UpdateError('Сначала проверьте наличие новой версии приложения.');
      await ensureDirectory();
      const target = installerPath();
      publish({ status: 'downloading', version: manifest.version, progress: 0 });
      // A previous verified download can be reused, but is hashed again first.
      try {
        await verifyInstaller(target);
        verifiedInstaller = target;
        return publish({ status: 'ready', version: manifest.version, progress: 100 });
      } catch { /* Missing or altered cache: replace it with a fresh download. */ }
      partialFile = path.join(updatesDirectory, `${manifest.filename}.${randomBytes(8).toString('hex')}.partial`);
      const { response, dispose } = await openResponse(`${SERVER_ORIGIN}/downloads/${manifest.filename}`, manifest.size, 20 * 60 * 1000);
      const contentLength = response.headers['content-length'];
      if (contentLength !== undefined && Number(contentLength) !== manifest.size) { dispose(); throw new UpdateError('Размер установщика на сервере не совпал с описанием обновления.'); }
      let received = 0, lastProgressAt = 0;
      const hash = createHash('sha256');
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > manifest.size) return callback(new UpdateError('Сервер передал слишком большой установщик.'));
        hash.update(chunk);
        if (Date.now() - lastProgressAt >= 150) {
          lastProgressAt = Date.now();
          publish({ status: 'downloading', version: manifest.version, progress: Math.min(99, Math.floor(received / manifest.size * 100)) });
        }
        callback(null, chunk);
      } });
      try {
        await pipeline(response, meter, fs.createWriteStream(partialFile, { flags: 'wx', mode: 0o600 }));
      } finally { dispose(); }
      if (received !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new UpdateError('Установщик не прошёл проверку целостности. Повторите загрузку.');
      await fsp.rename(partialFile, target);
      partialFile = null;
      verifiedInstaller = target;
      return publish({ status: 'ready', version: manifest.version, progress: 100 });
    });
  }

  function installUpdate() {
    return withOperation(async () => {
      if (process.platform !== 'win32' || state.status !== 'ready' || !verifiedInstaller || verifiedInstaller !== installerPath()) throw new UpdateError('Сначала загрузите и проверьте новую версию.');
      // The executable is checked a second time immediately before Windows starts
      // it. No command, path or arguments come from the renderer.
      await verifyInstaller(verifiedInstaller);
      const environment = { ...process.env };
      for (const key of Object.keys(environment)) if (key.startsWith('PORTABLE_EXECUTABLE_')) delete environment[key];
      let child;
      try {
        child = spawn(verifiedInstaller, [], { cwd: updatesDirectory, detached: true, stdio: 'ignore', shell: false, windowsHide: false, env: environment });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      } catch { throw new UpdateError('Не удалось запустить установщик. Повторите загрузку или установите приложение через Signal-Setup.'); }
      child.unref();
      setImmediate(onInstallLaunched);
      return getState();
    });
  }

  async function dispose() {
    disposed = true;
    cancelRequest?.();
    if (operation) await operation;
    await cleanupPartial();
  }

  return Object.freeze({ getState, checkUpdate, downloadUpdate, installUpdate, dispose });
}

module.exports = { createManualUpdater };
