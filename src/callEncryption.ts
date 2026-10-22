import { ExternalE2EEKeyProvider, isE2EESupported } from 'livekit-client';
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
