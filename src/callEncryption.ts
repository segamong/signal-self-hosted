import { ExternalE2EEKeyProvider, isE2EESupported, RoomEvent, type Room, type Participant } from 'livekit-client';
import EncryptionWorker from 'livekit-client/e2ee-worker?worker';

export interface CallEncryptionParameters {
  required: true;
  key: string;
  epoch: string;
  algorithm: 'AES-GCM';
  keyDerivation: 'PBKDF2';
}

export function createCallEncryption() {
  if (!isE2EESupported() || !globalThis.crypto?.subtle) {
    throw new Error('Этот браузер не поддерживает шифрование звонков. Обновите Chrome или приложение Сигнал.');
  }
  const keyProvider = new ExternalE2EEKeyProvider();
  const worker = new EncryptionWorker();
  return { keyProvider, worker };
}

// The SDK flag is updated by a worker acknowledgement after signaling supplies
// the participant identity. setE2EEEnabled() alone only sets the publish policy.
export function waitForCallEncryption(room: Room, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantEncryptionStatusChanged, changed);
      room.off(RoomEvent.EncryptionError, failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const changed = (enabled: boolean, participant?: Participant) => {
      if (enabled && (participant?.isLocal || room.isE2EEEnabled)) finish();
    };
    const failed = () => finish(new Error('Не удалось подготовить шифрование звонка. Подключитесь снова.'));
    const aborted = () => finish(new DOMException('Подключение отменено', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Браузер не подтвердил шифрование звонка. Обновите страницу и повторите подключение.')), 12000);
    room.on(RoomEvent.ParticipantEncryptionStatusChanged, changed);
    room.on(RoomEvent.EncryptionError, failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (room.isE2EEEnabled) finish();
  });
}

export async function prepareCallKey(provider: ExternalE2EEKeyProvider, value: unknown) {
  const data = value as Partial<CallEncryptionParameters> | undefined;
  if (data?.required !== true || data.algorithm !== 'AES-GCM' || data.keyDerivation !== 'PBKDF2'
      || typeof data.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.key)
      || typeof data.epoch !== 'string' || !/^\d+$/.test(data.epoch)) {
    throw new Error('Сервер не выдал действительный ключ шифрования. Подключение к звонку остановлено.');
  }
  // Keep the random passphrase as a string: all clients use LiveKit's PBKDF2
  // path with its default salt and AES-128 key size for native interoperability.
  await provider.setKey(data.key);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.key)));
  const fingerprint = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join(' ');
  return { fingerprint, epoch: data.epoch };
}
