import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { validateSettings, readSettings, writePrivate, render, checkDns } from '../config.mjs';

try {
  const { values } = parseArgs({ options: {
    'server-ip': { type: 'string' }, 'https-port': { type: 'string', default: '9443' },
    'app-domain': { type: 'string' }, 'rtc-domain': { type: 'string' }, email: { type: 'string' },
    'config-dir': { type: 'string', default: '/etc/signal' }, 'check-dns': { type: 'boolean', default: false },
  }});
  const configDir = resolve(values['config-dir']);
  mkdirSync(configDir, { recursive: true, mode: 0o755 });
  chmodSync(configDir, 0o755);
  const settingsPath = join(configDir, 'settings.env');
  let settings;
  if (existsSync(settingsPath)) {
    settings = readSettings(settingsPath);
    if (values['server-ip'] && settings.SERVER_IP !== values['server-ip']) throw new Error('Existing SERVER_IP differs. Edit settings.env intentionally before reconfiguring.');
  } else {
    const random = () => randomBytes(32).toString('base64url');
    settings = validateSettings({
      TLS_MODE: values['app-domain'] || values['rtc-domain'] ? 'domain' : 'ip',
      APP_DOMAIN: values['app-domain'] ?? '', RTC_DOMAIN: values['rtc-domain'] ?? '',
      SERVER_IP: values['server-ip'], HTTPS_PORT: values['https-port'], ACME_EMAIL: values.email ?? '',
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: random(), LIVEKIT_API_KEY: `API${random()}`,
      LIVEKIT_API_SECRET: random(), TURN_ENABLED: 'false',
    });
    writePrivate(settingsPath, Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (values['check-dns']) await checkDns(settings);
  const origin = render(settings, { outputDir: configDir, dataDir: '/var/lib/signal', directoryMode: 0o755 });
  console.log(`Native configuration ready: ${origin}. Secrets remain in settings.env and app.env.`);
  console.log('Apply root:signal-media 0640 to livekit.yaml and root:signal-caddy 0640 to Caddyfile before starting services.');
} catch (error) {
  console.error(`Native configuration failed: ${error.message}`);
  process.exitCode = 1;
}
