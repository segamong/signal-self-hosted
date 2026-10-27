"""Enable duplex HTTP/2 only on the owned loopback VPN upstream."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess

os.umask(0o077)
config = json.loads(Path('/etc/signal-vpn/server.json').read_text())
if config['inbounds'][0]['streamSettings']['xhttpSettings']['mode'] != 'auto':
    raise RuntimeError('Unexpected VPN inbound mode')
caddy = Path('/etc/signal/Caddyfile')
before = caddy.read_text()
needle = 'reverse_proxy 127.0.0.1:39443'
replacement = 'reverse_proxy h2c://127.0.0.1:39443'
if before.count(needle) != 1 or replacement in before:
    raise RuntimeError('Unexpected VPN upstream configuration')
candidate = before.replace(needle, replacement, 1)
if candidate.count('forward_auth 127.0.0.1:3000') != 2 or 'protocols tls1.3' not in candidate:
    raise RuntimeError('Existing admission/TLS invariants not met')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/root') / ('signal-vpn-h2c-' + stamp)
backup.mkdir(mode=0o700)
shutil.copy2(caddy, backup / 'Caddyfile')
staging = Path('/etc/signal/Caddyfile.vpn-h2c-candidate')
staging.write_text(candidate)
staging.chmod(0o644)
check = subprocess.run(['/opt/signal/runtime/bin/caddy', 'validate', '--config', str(staging), '--adapter', 'caddyfile'],
    capture_output=True, timeout=20)
if check.returncode:
    raise RuntimeError('Caddy rejected HTTP/2 upstream configuration')
reloadable = subprocess.check_output(['systemctl', 'show', '-p', 'CanReload', '--value', 'signal-caddy'], text=True).strip() == 'yes'
operation = 'reload' if reloadable else 'restart'
try:
    caddy.write_text(candidate)
    caddy.chmod(0o644)
    subprocess.run(['systemctl', operation, 'signal-caddy'], check=True, capture_output=True, timeout=25)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'signal-caddy', 'signal-vpn'], check=True, timeout=5)
except Exception:
    caddy.write_text(before)
    caddy.chmod(0o644)
    subprocess.run(['systemctl', operation, 'signal-caddy'], check=True, capture_output=True, timeout=25)
    raise
finally:
    staging.unlink(missing_ok=True)
print(json.dumps({'vpnUpstream': 'HTTP/2 on loopback', 'publicTLS': 'TLS 1.3', 'backup': str(backup)}))
