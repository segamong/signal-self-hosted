export type CustomAudioDirection = 'incoming' | 'outgoing';
export type CustomCallAudioMetadata = {revision: string; duration: number};
export type CustomCallAudio = CustomCallAudioMetadata & {wav: ArrayBuffer};
type MutationOptions = {canCommit?: () => boolean; signal?: AbortSignal};
type StoredAudio = CustomCallAudio & {schema: 1; direction: CustomAudioDirection};
type Format = 'wav' | 'mp3' | 'ogg';
type Operation = {revision: number; controller: AbortController; done: Promise<unknown>};

const DATABASE = 'signal.custom-call-audio.v1', STORE = 'slots';
const MAX_BYTES = 8 * 1024 * 1024, MAX_SECONDS = 15, SAMPLE_RATE = 24_000;
const MAX_FRAMES = MAX_SECONDS * SAMPLE_RATE, MAX_DECODED_CELLS = 12_000_000;
const MAX_WAV_BYTES = 44 + MAX_FRAMES * 2, PEAK = .98;
const DECODE_TIMEOUT = 12_000, STORAGE_TIMEOUT = 8_000;
const MIME: Record<Format, readonly string[]> = {
  wav: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave', 'audio/x-pn-wav'],
  mp3: ['audio/mpeg', 'audio/x-mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/mpeg3', 'audio/x-mpeg3'],
  ogg: ['audio/ogg', 'audio/opus', 'audio/x-ogg', 'application/ogg'],
};
const operations = new Map<CustomAudioDirection, Operation>();
const cache = new Map<CustomAudioDirection, StoredAudio>();
let database: Promise<IDBDatabase> | undefined, revision = 0, decoders = 0;

function cancelled() { return new DOMException('Действие отменено.', 'AbortError'); }
function invalid(message = 'Не удалось прочитать аудио. Выберите корректный файл WAV, MP3 или Ogg Opus.') { return new Error(message); }
function durationError() { return invalid('Мелодия должна быть не длиннее 15 секунд. Сначала обрежьте аудио.'); }
function directionValue(direction: CustomAudioDirection) {
  if (direction !== 'incoming' && direction !== 'outgoing') throw invalid('Неизвестный тип мелодии звонка.');
}
function storageError(reason: unknown): Error {
  if (reason instanceof DOMException && reason.name === 'AbortError') return cancelled();
  if (reason instanceof DOMException && reason.name === 'QuotaExceededError') return invalid('Недостаточно места для мелодии. Освободите место в хранилище приложения.');
  if (reason instanceof Error && /[А-Яа-яЁё]/.test(reason.message)) return reason;
  return invalid('Локальное хранилище мелодий недоступно. Разрешите хранение данных для приложения и повторите попытку.');
}
function check(signal?: AbortSignal, canCommit?: () => boolean) {
  if (signal?.aborted || (canCommit && !canCommit())) throw cancelled();
}
function ascii(bytes: Uint8Array, offset: number, value: string) {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  return true;
}
function dimensions(sampleRate: number, channels: number, frames: number, extraSeconds = 0) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 || !Number.isInteger(channels) || channels < 1 || channels > 8 || !Number.isSafeInteger(frames) || frames <= 0) throw invalid();
  if (frames / sampleRate > MAX_SECONDS + extraSeconds) throw durationError();
  if (frames * channels > MAX_DECODED_CELLS) throw invalid('Слишком сложный аудиофайл. Сохраните его как обычный моно- или стереофайл.');
}

function preflightWav(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 44 || view.getUint32(4, true) + 8 !== bytes.length) throw invalid();
  let offset = 12, chunks = 0, sampleRate = 0, channels = 0, blockAlign = 0, dataBytes = -1;
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 8 > bytes.length) throw invalid();
    const length = view.getUint32(offset + 4, true), start = offset + 8, end = start + length;
    if (end > bytes.length || end + (length & 1) > bytes.length) throw invalid();
    if (ascii(bytes, offset, 'fmt ')) {
      if (sampleRate || length < 16 || length > 4096) throw invalid();
      let format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true); sampleRate = view.getUint32(start + 4, true);
      blockAlign = view.getUint16(start + 12, true);
      const bits = view.getUint16(start + 14, true);
      if (format === 0xfffe) {
        const guidTail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (length < 40 || view.getUint16(start + 16, true) < 22 || !guidTail.every((value, index) => bytes[start + 28 + index] === value)) throw invalid();
        format = view.getUint32(start + 24, true);
      }
      if (![1, 3].includes(format) || ![8, 16, 24, 32].includes(bits) || (format === 3 && bits !== 32) || blockAlign !== channels * bits / 8 || view.getUint32(start + 8, true) !== sampleRate * blockAlign) throw invalid();
    } else if (ascii(bytes, offset, 'data')) {
      if (dataBytes >= 0) throw invalid(); dataBytes = length;
    }
    offset = end + (length & 1);
  }
  if (offset !== bytes.length || !blockAlign || dataBytes <= 0 || dataBytes % blockAlign) throw invalid();
  dimensions(sampleRate, channels, dataBytes / blockAlign);
}

function mp3Frame(view: DataView, offset: number) {
  if (offset + 4 > view.byteLength) throw invalid();
  const header = view.getUint32(offset, false), version = (header >>> 19) & 3, layer = (header >>> 17) & 3;
  const bitRateIndex = (header >>> 12) & 15, rateIndex = (header >>> 10) & 3;
  if ((header & 0xffe00000) !== (0xffe00000 | 0) || version === 1 || layer !== 1 || !bitRateIndex || bitRateIndex === 15 || rateIndex === 3) throw invalid();
  const rate = [44_100, 48_000, 32_000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const size = Math.floor((version === 3 ? 144_000 : 72_000) * rates[bitRateIndex] / rate) + ((header >>> 9) & 1);
  if (size < 4 || offset + size > view.byteLength) throw invalid();
  return {size, rate, frames: version === 3 ? 1152 : 576, channels: ((header >>> 6) & 3) === 3 ? 1 : 2};
}
function preflightMp3(bytes: Uint8Array, view: DataView) {
  let offset = 0, rate = 0, channels = 0, frames = 0, count = 0;
  if (ascii(bytes, 0, 'ID3')) {
    if (bytes.length < 10 || bytes[3] < 2 || bytes[3] > 4 || bytes[4] === 0xff || [6, 7, 8, 9].some(index => bytes[index] & 0x80)) throw invalid();
    const length = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    if (length > 1024 * 1024) throw invalid('В MP3 слишком много служебных данных. Сохраните мелодию без обложки и метаданных.');
    offset = 10 + length + (bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0);
    if (offset >= bytes.length) throw invalid();
  }
  while (offset < bytes.length) {
    if (bytes.length - offset === 128 && ascii(bytes, offset, 'TAG')) {offset += 128; break;}
    if (++count > 3000) throw durationError();
    const frame = mp3Frame(view, offset);
    if (rate && frame.rate !== rate) throw invalid();
    rate = frame.rate; channels = Math.max(channels, frame.channels); frames += frame.frames; offset += frame.size;
    dimensions(rate, channels, frames, .15);
  }
  if (!count || offset !== bytes.length) throw invalid();
}

function preflightOgg(bytes: Uint8Array, view: DataView) {
  let offset = 0, pages = 0, serial: number | undefined, sequence = 0, packet = 0, packetBytes = 0;
  let prefix: number[] = [], sampleRate = 0, channels = 0, preSkip = 0;
  let maxGranule = 0n, ended = false, opusFrames = 0, audioPackets = 0;
  const finishPacket = () => {
    const header = new Uint8Array(prefix);
    if (!packet) {
      if (ascii(header, 0, 'OpusHead')) {
        if (packetBytes < 19 || header[8] > 15 || !header[9] || header[9] > 8) throw invalid();
        sampleRate = 48_000; channels = header[9]; preSkip = header[10] | (header[11] << 8);
      } else throw invalid('Для Ogg поддерживается только звук Opus. Сохраните мелодию в Ogg Opus, WAV или MP3.');
      dimensions(sampleRate, channels, 1);
    } else {
      if (packet === 1) {if (!ascii(header, 0, 'OpusTags')) throw invalid();}
      else {
        if (!packetBytes) throw invalid();
        const config = header[0] >> 3, code = header[0] & 3;
        const perFrame = config >= 16 ? 120 * (1 << (config & 3)) : config >= 12 ? 480 * (1 << (config & 1)) : (config & 3) === 3 ? 2880 : 480 * (1 << (config & 3));
        const count = code === 0 ? 1 : code !== 3 ? 2 : packetBytes >= 2 ? header[1] & 63 : 0;
        if (!count || count * perFrame > 5760) throw invalid();
        opusFrames += count * perFrame; audioPackets++;
        if (opusFrames - preSkip > (MAX_SECONDS + .15) * 48_000) throw durationError();
      }
    }
    packet++; packetBytes = 0; prefix = [];
  };
  while (offset < bytes.length) {
    if (++pages > 65_536 || ended || offset + 27 > bytes.length || !ascii(bytes, offset, 'OggS') || bytes[offset + 4] !== 0) throw invalid();
    const flags = bytes[offset + 5], segments = bytes[offset + 26], payload = offset + 27 + segments;
    if ((flags & ~7) || payload > bytes.length || Boolean(flags & 1) !== Boolean(packetBytes)) throw invalid();
    const pageSerial = view.getUint32(offset + 14, true), pageSequence = view.getUint32(offset + 18, true);
    if (serial === undefined) {if (!(flags & 2) || pageSequence !== 0) throw invalid(); serial = pageSerial;}
    else if (pageSerial !== serial || (flags & 2) || pageSequence !== sequence) throw invalid('Ogg должен содержать одну звуковую дорожку без объединённых файлов.');
    sequence = pageSequence + 1;
    const granule = view.getBigUint64(offset + 6, true);
    if (granule !== 0xffff_ffff_ffff_ffffn) {
      if (granule > BigInt(192_000 * (MAX_SECONDS + 2) + 65_535)) throw durationError();
      if (granule > maxGranule) maxGranule = granule;
    }
    let cursor = payload;
    for (let index = 0; index < segments; index++) {
      const length = bytes[offset + 27 + index];
      if (cursor + length > bytes.length) throw invalid();
      for (let item = 0; item < length && prefix.length < 4096; item++) prefix.push(bytes[cursor + item]);
      packetBytes += length; cursor += length;
      if (packetBytes > MAX_BYTES || (!packet && packetBytes > 4096)) throw invalid();
      if (length < 255) finishPacket();
    }
    ended = Boolean(flags & 4); offset = cursor;
  }
  if (!ended || packetBytes || !sampleRate || !audioPackets || maxGranule <= BigInt(preSkip)) throw invalid();
  dimensions(sampleRate, channels, Number(maxGranule) - preSkip, .15);
}

function inspect(bytes: Uint8Array, mime: string) {
  if (bytes.length < 16 || bytes.length > MAX_BYTES) throw invalid('Выберите аудиофайл размером не более 8 МБ.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: Format;
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) format = 'wav';
  else if (ascii(bytes, 0, 'OggS')) format = 'ogg';
  else if (ascii(bytes, 0, 'ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) format = 'mp3';
  else throw invalid('Этот файл не является поддерживаемым аудио. Нужен WAV, MP3 или Ogg Opus.');
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  if (type && type !== 'application/octet-stream' && !MIME[format].includes(type)) throw invalid('Тип файла не совпадает с его содержимым. Сохраните аудио заново в WAV, MP3 или Ogg Opus.');
  if (format === 'wav') preflightWav(bytes, view);
  else if (format === 'mp3') preflightMp3(bytes, view);
  else preflightOgg(bytes, view);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, timeout: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(value as T);};
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(invalid(message)), timeout);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    promise.then(value => finish(null, value), error => finish(error));
  });
}

async function decode(bytes: ArrayBuffer, signal: AbortSignal): Promise<AudioBuffer> {
  check(signal);
  if (decoders >= 2) throw invalid('Декодирование предыдущего файла ещё завершается. Подождите немного и повторите попытку.');
  let context: AudioContext;
  try {context = new AudioContext({sampleRate: SAMPLE_RATE});}
  catch {throw invalid('Браузер не смог открыть аудиофайл. Обновите браузер или приложение.');}
  decoders++;
  let native: Promise<AudioBuffer>;
  try {native = context.decodeAudioData(bytes);}
  catch {decoders--; void context.close().catch(() => {}); throw invalid();}
  // Abort/timeout release our caller immediately. Native decoding is not fully
  // cancellable, so retain its concurrency slot until its promise settles.
  void native.then(() => {decoders--;}, () => {decoders--;});
  try {
    return await raceAbort(native, signal, DECODE_TIMEOUT, 'Декодирование заняло слишком много времени. Сохраните короткую мелодию в WAV или MP3.');
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw cancelled();
    if (error instanceof Error && /[А-Яа-яЁё]/.test(error.message)) throw error;
    throw invalid('Браузер не смог декодировать это аудио. Попробуйте WAV, MP3 или другой файл.');
  } finally {void context.close().catch(() => {});}
}

function canonicalWav(buffer: AudioBuffer, signal: AbortSignal): {wav: ArrayBuffer; duration: number} {
  const rate = buffer.sampleRate, channels = buffer.numberOfChannels, length = buffer.length;
  dimensions(rate, channels, length);
  if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_SECONDS + 1 / rate) throw durationError();
  const frames = Math.floor(length * SAMPLE_RATE / rate);
  if (!frames || frames > MAX_FRAMES) throw durationError();
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel++) {
    check(signal); const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index++) {if (!Number.isFinite(data[index])) throw invalid('Аудиофайл содержит повреждённые отсчёты. Выберите другой файл.'); mono[index] += data[index] / channels;}
  }
  const output = new Float32Array(frames); let peak = 0;
  for (let index = 0; index < frames; index++) {
    if (!(index & 16383)) check(signal);
    const position = index * rate / SAMPLE_RATE, left = Math.min(length - 1, Math.floor(position)), fraction = position - left;
    const value = mono[left] * (1 - fraction) + mono[Math.min(length - 1, left + 1)] * fraction;
    if (!Number.isFinite(value)) throw invalid(); output[index] = value; peak = Math.max(peak, Math.abs(value));
  }
  const wav = new ArrayBuffer(44 + frames * 2), view = new DataView(wav), bytes = new Uint8Array(wav);
  const text = (offset: number, value: string) => {for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);};
  text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * 2, true);
  const gain = peak > PEAK ? PEAK / peak : 1;
  for (let index = 0; index < frames; index++) view.setInt16(44 + index * 2, Math.round(Math.max(-PEAK, Math.min(PEAK, output[index] * gain)) * 32767), true);
  return {wav, duration: frames / SAMPLE_RATE};
}

function validateStored(value: unknown, direction: CustomAudioDirection): StoredAudio {
  const row = value as Partial<StoredAudio> | null;
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'direction,duration,revision,schema,wav' || row.schema !== 1 || row.direction !== direction || typeof row.revision !== 'string' || !/^[a-f0-9]{32}$/.test(row.revision) || typeof row.duration !== 'number' || !Number.isFinite(row.duration) || !(row.wav instanceof ArrayBuffer) || row.wav.byteLength < 46 || row.wav.byteLength > MAX_WAV_BYTES || (row.wav.byteLength - 44) % 2) throw invalid('Сохранённая мелодия повреждена. Удалите её и выберите файл заново.');
  const view = new DataView(row.wav), bytes = new Uint8Array(row.wav), frames = (row.wav.byteLength - 44) / 2;
  if (!ascii(bytes, 0, 'RIFF') || view.getUint32(4, true) !== row.wav.byteLength - 8 || !ascii(bytes, 8, 'WAVEfmt ') || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== SAMPLE_RATE || view.getUint32(28, true) !== SAMPLE_RATE * 2 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || !ascii(bytes, 36, 'data') || view.getUint32(40, true) !== frames * 2 || Math.abs(row.duration - frames / SAMPLE_RATE) > 1e-9) throw invalid('Сохранённая мелодия повреждена. Удалите её и выберите файл заново.');
  for (let offset = 44; offset < row.wav.byteLength; offset += 2) if (Math.abs(view.getInt16(offset, true)) > Math.round(PEAK * 32767)) throw invalid('Сохранённая мелодия повреждена. Удалите её и выберите файл заново.');
  return row as StoredAudio;
}
function copy(row: CustomCallAudio): CustomCallAudio {return {revision: row.revision, duration: row.duration, wav: row.wav.slice(0)};}
function getDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest, settled = false;
    const fail = (error: unknown) => {if (!settled) {settled = true; clearTimeout(timer); reject(storageError(error));}};
    const timer = setTimeout(() => fail(invalid('Хранилище мелодий не отвечает. Закройте другие окна приложения и повторите попытку.')), STORAGE_TIMEOUT);
    try {request = indexedDB.open(DATABASE, 1);} catch (error) {fail(error); return;}
    request.onupgradeneeded = () => {if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'direction'});};
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(invalid('Хранилище мелодий занято другим окном. Закройте другие окна приложения и повторите попытку.'));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {db.close(); return;}
      try {
        const tx = db.transaction(STORE, 'readonly'), store = tx.objectStore(STORE);
        if (db.objectStoreNames.length !== 1 || store.keyPath !== 'direction' || store.autoIncrement || store.indexNames.length) throw invalid('Хранилище мелодий повреждено. Очистите данные приложения и повторите попытку.');
      } catch (error) {db.close(); fail(error); return;}
      db.onversionchange = () => {db.close(); if (database === opening) database = undefined; cache.clear();};
      db.onclose = () => {if (database === opening) database = undefined; cache.clear();};
      settled = true; clearTimeout(timer); resolve(db);
    };
  });
  database = opening;
  void opening.catch(() => {if (database === opening) database = undefined;});
  return opening;
}

export function supportsCustomCallAudio(): boolean {
  try {return typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && typeof AudioContext === 'function' && typeof crypto?.getRandomValues === 'function';} catch {return false;}
}
export async function getCustomCallAudio(direction: CustomAudioDirection): Promise<CustomCallAudio | null> {
  directionValue(direction);
  if (!supportsCustomCallAudio()) return null;
  try {
    const db = await getDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly'), store = tx.objectStore(STORE), request = store.get(direction), keys = store.getAllKeys();
      let result: unknown, failure: unknown;
      const timer = setTimeout(() => {failure = invalid('Хранилище мелодий не отвечает. Повторите попытку.'); try {tx.abort();} catch {}}, STORAGE_TIMEOUT);
      request.onsuccess = () => {result = request.result;};
      keys.onsuccess = () => {if (keys.result.length > 2 || keys.result.some(key => key !== 'incoming' && key !== 'outgoing')) {failure = invalid('Хранилище мелодий повреждено. Очистите данные приложения и повторите попытку.'); tx.abort();}};
      tx.oncomplete = () => {clearTimeout(timer); resolve(result);};
      tx.onabort = tx.onerror = () => {clearTimeout(timer); reject(failure ?? tx.error);};
    });
    if (value === undefined) {cache.delete(direction); return null;}
    const row = validateStored(value, direction), cached = cache.get(direction);
    // The revision is the decoder cache key. Never expose the cached buffer:
    // decodeAudioData may detach the ArrayBuffer it receives.
    if (!cached || cached.revision !== row.revision || cached.duration !== row.duration) cache.set(direction, row);
    return copy(cache.get(direction)!);
  } catch (error) {throw storageError(error);}
}

function operation<T>(direction: CustomAudioDirection, options: MutationOptions, run: (signal: AbortSignal, guard: () => void) => Promise<T>): Promise<T> {
  directionValue(direction);
  const previous = operations.get(direction), controller = new AbortController(), version = ++revision;
  previous?.controller.abort();
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) controller.abort();
  const guard = () => {check(controller.signal, options.canCommit); if (operations.get(direction)?.revision !== version) throw cancelled();};
  const current: Operation = {revision: version, controller, done: Promise.resolve()};
  operations.set(direction, current);
  const promise = (previous?.done.catch(() => {}) ?? Promise.resolve()).then(async () => {
    guard(); if (!supportsCustomCallAudio()) throw invalid('Импорт мелодий недоступен в этом браузере. Обновите браузер или приложение.');
    return run(controller.signal, guard);
  }).finally(() => {options.signal?.removeEventListener('abort', abort); if (operations.get(direction) === current) operations.delete(direction);});
  current.done = promise;
  return promise;
}

async function mutate(direction: CustomAudioDirection, row: StoredAudio | null, signal: AbortSignal, guard: () => void) {
  const db = await raceAbort(getDatabase(), signal, STORAGE_TIMEOUT, 'Хранилище мелодий не отвечает. Повторите попытку.');
  guard();
  try {
    await new Promise<void>((resolve, reject) => {
      guard(); const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
      let failure: unknown, completed = false;
      const abort = () => {failure = cancelled(); try {tx.abort();} catch {}};
      const timer = setTimeout(() => {failure = invalid('Сохранение мелодии заняло слишком много времени. Повторите попытку.'); try {tx.abort();} catch {}}, STORAGE_TIMEOUT);
      const cleanup = () => {completed = true; clearTimeout(timer); signal.removeEventListener('abort', abort);};
      signal.addEventListener('abort', abort, {once: true});
      tx.oncomplete = () => {cleanup(); if (row) cache.set(direction, row); else cache.delete(direction); resolve();};
      tx.onabort = tx.onerror = () => {if (completed) return; cleanup(); reject(failure ?? tx.error);};
      try {
        guard();
        const before = store.get(direction);
        before.onsuccess = () => {
          try {
            guard(); const write = row ? store.put(row) : store.delete(direction);
            write.onsuccess = () => {try {guard(); if (typeof tx.commit === 'function') tx.commit();} catch (error) {failure = error; try {tx.abort();} catch {}}};
          } catch (error) {failure = error; try {tx.abort();} catch {}}
        };
      } catch (error) {failure = error; try {tx.abort();} catch {}}
    });
  } catch (error) {throw storageError(error);}
}

export function importCustomCallAudio(direction: CustomAudioDirection, file: File, options: MutationOptions = {}): Promise<CustomCallAudio> {
  return operation(direction, options, async (signal, guard) => {
    if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size < 16 || file.size > MAX_BYTES) throw invalid('Выберите аудиофайл размером не более 8 МБ.');
    let original: ArrayBuffer;
    try {original = await raceAbort(file.arrayBuffer(), signal, 8_000, 'Не удалось прочитать файл вовремя. Выберите файл с локального диска.');}
    catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw cancelled();
      if (error instanceof Error && /[А-Яа-яЁё]/.test(error.message)) throw error;
      throw invalid('Не удалось прочитать файл. Выберите доступный файл с локального диска.');
    }
    guard(); inspect(new Uint8Array(original), file.type);
    const decoded = await decode(original, signal); guard();
    const canonical = canonicalWav(decoded, signal); guard();
    const random = crypto.getRandomValues(new Uint8Array(16));
    const row: StoredAudio = {schema: 1, direction, revision: Array.from(random, value => value.toString(16).padStart(2, '0')).join(''), ...canonical};
    await mutate(direction, row, signal, guard);
    return copy(row);
  });
}
export function deleteCustomCallAudio(direction: CustomAudioDirection, options: MutationOptions = {}): Promise<void> {
  return operation(direction, options, async (signal, guard) => {await mutate(direction, null, signal, guard);});
}
