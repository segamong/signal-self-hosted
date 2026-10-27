import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

OLD = '13.143.172.92'
NEW = '177.3.212.182'
CANONICAL = 'https://signal-on.ru'
BACKUP = Path('/root/signal-maint-20261026T181257Z')
assert (BACKUP / 'before-changes.tar.enc').is_file()

def write(path, text):
    info = path.stat()
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, info.st_uid, info.st_gid)
        os.chmod(temporary, info.st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def env_replace(path, updates):
    original = path.read_text()
    candidate = original
    for key, value in updates.items():
        candidate, count = re.subn(r'^' + re.escape(key) + r'=.*$', key + '=' + value,
                                   candidate, flags=re.MULTILINE)
        assert count == 1, 'Expected one setting: ' + key
    before = [line for line in original.splitlines() if line.split('=', 1)[0] not in updates]
    after = [line for line in candidate.splitlines() if line.split('=', 1)[0] not in updates]
    assert before == after
    return candidate

caddy = Path('/etc/signal/Caddyfile')
original = caddy.read_text()
assert 'https://' + OLD + ':9443 {' in original
candidate = original.replace(OLD, NEW)
# Keep the panel's old TLS name until its new IP certificate has been installed.
candidate = candidate.replace('tls_server_name ' + NEW, 'tls_server_name ' + OLD)
candidate = re.sub(r'(request_header @\w+ Origin )https://' + re.escape(NEW) + ':9443',
                   r'\g<1>' + CANONICAL, candidate)
needle = 'https://' + NEW + ':9443 {\n  import public_tls\n'
assert needle in candidate
candidate = candidate.replace(needle, needle +
    '  @trusted_ip_origin header Origin https://' + NEW + ':9443\n' +
    '  request_header @trusted_ip_origin Origin ' + CANONICAL + '\n', 1)
assert candidate.count('forward_auth 127.0.0.1:3000') == original.count('forward_auth 127.0.0.1:3000') == 2
assert candidate.count('uri /internal/media-access') == 2
assert candidate.count('@internal path /internal /internal/*') == 2
staging = Path('/etc/signal/Caddyfile.candidate')
staging.write_text(candidate)
staging.chmod(0o644)
validation = subprocess.run(['/opt/signal/runtime/bin/caddy', 'validate', '--config',
                              str(staging), '--adapter', 'caddyfile'], capture_output=True, text=True)
if validation.returncode:
    print(validation.stderr)
    raise SystemExit('Caddy validation failed; no production files changed')

settings = Path('/etc/signal/settings.env')
app = Path('/etc/signal/app.env')
media = Path('/etc/signal/livekit.yaml')
settings_text = env_replace(settings, {'SERVER_IP': NEW})
app_text = env_replace(app, {'PUBLIC_URL': CANONICAL, 'APP_ORIGIN': CANONICAL,
                             'LIVEKIT_PUBLIC_URL': 'wss://signal-on.ru'})
media_text = media.read_text()
assert re.search(r'^\s*node_ip:\s*' + re.escape(OLD) + r'\s*$', media_text, re.MULTILINE)
media_text = media_text.replace(OLD, NEW)

write(settings, settings_text)
write(app, app_text)
write(media, media_text)
write(caddy, candidate)
print('Configuration validated and IP settings updated', flush=True)
subprocess.run(['systemctl', 'restart', 'signal-media', 'signal-app', 'signal-caddy'], check=True)
states = {unit: subprocess.check_output(['systemctl', 'is-active', unit], text=True).strip()
          for unit in ['signal-media', 'signal-app', 'signal-caddy', 'x-ui']}
assert all(value == 'active' for value in states.values())
receipt = {'primary_ip': NEW, 'app_origin': CANONICAL, 'media_url': 'wss://signal-on.ru',
           'services': states, 'panel_tls_migration_pending': True, 'backup_root': str(BACKUP)}
(BACKUP / 'ip-migration-stage1.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
