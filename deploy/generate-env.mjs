import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { deployDir, validateSettings } from './config.mjs';

try {
  const { values } = parseArgs({ options: {
    'app-domain': { type: 'string' }, 'rtc-domain': { type: 'string' },
    'server-ip': { type: 'string' }, email: { type: 'string' },
    'https-port': { type: 'string', default: '8443' },
    'admin-username': { type: 'string', default: 'admin' },
    'ip-only': { type: 'boolean', default: false },
  }});
  const random = () => randomBytes(32).toString('base64url');
  const settings = validateSettings({
    TLS_MODE: values['ip-only'] ? 'ip' : 'domain',
    APP_DOMAIN: values['app-domain'] ?? '', RTC_DOMAIN: values['rtc-domain'] ?? '',
    SERVER_IP: values['server-ip'], ACME_EMAIL: values.email ?? '',
    HTTPS_PORT: values['https-port'], ADMIN_USERNAME: values['admin-username'],
    ADMIN_PASSWORD: random(),
    LIVEKIT_API_KEY: `API${random()}`, LIVEKIT_API_SECRET: random(), TURN_ENABLED: 'false',
  });
  const destination = join(deployDir, '.env');
  writeFileSync(destination, '# Private configuration. Do not send to chat or Git.\n' + Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
  chmodSync(destination, 0o600);
  console.log('Создан deploy/.env с новыми случайными секретами (0600). Существующий файл никогда не перезаписывается.');
  console.log('Имя и пароль администратора находятся в этом файле. Не отправляйте файл в чат или Git.');
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'deploy/.env уже существует. Генерация отменена, чтобы сохранить ключи и учётную запись.' : error.message);
  process.exitCode = 1;
}
