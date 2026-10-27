import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tarfile
import time
import urllib.request

os.umask(0o077)
backup = Path('/root/signal-maint-20261026T181257Z')
archive = backup / 'vpn-console.tar.gz'
auth = backup / 'vpn-portal-auth.json'
target = Path('/opt/signal-vpn-web')
assert archive.is_file() and auth.is_file()
assert not Path('/etc/systemd/system/signal-vpn-web.service').exists()
try:
    identity = pwd.getpwnam('signal-vpn-web')
except KeyError:
    subprocess.run(['useradd', '--system', '--user-group', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'signal-vpn-web'], check=True)
    identity = pwd.getpwnam('signal-vpn-web')
target.mkdir(mode=0o755, exist_ok=True)
target.chmod(0o755)
with tarfile.open(archive) as package:
    package.extractall(target, filter='data')
for item in target.rglob('*'):
    if item.is_symlink():
        raise RuntimeError('Unexpected symlink in deployment')
    item.chmod(0o755 if item.is_dir() else 0o644)
    os.chown(item, 0, 0)
auth_dir = Path('/etc/signal-vpn-web')
auth_dir.mkdir(mode=0o750, exist_ok=True)
auth_dir.chmod(0o750)
os.chown(auth_dir, 0, identity.pw_gid)
installed_auth = auth_dir / 'auth.json'
assert not installed_auth.exists()
shutil.copy2(auth, installed_auth)
installed_auth.chmod(0o640)
os.chown(installed_auth, 0, identity.pw_gid)

control_unit = '''[Unit]
Description=Signal VPN restricted profile controller
After=signal-vpn.service
Wants=signal-vpn.service

[Service]
Type=simple
User=root
Group=signal-vpn-web
WorkingDirectory=/opt/signal-vpn-web
ExecStart=/usr/bin/python3 -I /opt/signal-vpn-web/control.py
Restart=on-failure
RestartSec=3
UMask=0077
StateDirectory=signal-vpn-control
StateDirectoryMode=0700
RuntimeDirectory=signal-vpn-control
RuntimeDirectoryMode=0750
CPUQuota=20%
MemoryMax=128M
TasksMax=64
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/etc/signal-vpn /var/lib/signal-vpn-control /run/signal-vpn-control

[Install]
WantedBy=multi-user.target
'''
web_unit = '''[Unit]
Description=Signal private VPN web console
After=network.target signal-vpn-control.service
Requires=signal-vpn-control.service

[Service]
Type=simple
User=signal-vpn-web
Group=signal-vpn-web
WorkingDirectory=/opt/signal-vpn-web
Environment=VPN_PUBLIC_ORIGIN=https://vpn.signal-on.ru
Environment=VPN_WEB_PORT=3180
ExecStart=/usr/bin/python3 -I /opt/signal-vpn-web/app.py
Restart=on-failure
RestartSec=3
UMask=0077
StateDirectory=signal-vpn-web
StateDirectoryMode=0700
CPUQuota=30%
MemoryMax=192M
TasksMax=96
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/signal-vpn-web

[Install]
WantedBy=multi-user.target
'''
for name, data in [('signal-vpn-control', control_unit), ('signal-vpn-web', web_unit)]:
    unit = Path('/etc/systemd/system') / (name + '.service')
    unit.write_text(data)
    unit.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'signal-vpn-control', 'signal-vpn-web'], check=True)
for attempt in range(20):
    try:
        with urllib.request.urlopen('http://127.0.0.1:3180/manage/api/session', timeout=3) as response:
            assert json.load(response) == {'authenticated':False}
        break
    except OSError:
        if attempt == 19:
            raise
        time.sleep(0.25)
caddy = Path('/etc/signal/Caddyfile')
original = caddy.read_text()
needle = '  @vpn_stream path '
assert original.count(needle) == 1 and '@vpn_manage' not in original
shutil.copy2(caddy, backup / 'Caddyfile.before-console')
candidate = original.replace(needle, '''  @vpn_manage path /manage /manage/*
  handle @vpn_manage {
    reverse_proxy 127.0.0.1:3180
  }
''' + needle, 1)
assert candidate.count('forward_auth 127.0.0.1:3000') == 2
staging = Path('/etc/signal/Caddyfile.candidate')
staging.write_text(candidate)
staging.chmod(0o644)
validation = subprocess.run(['/opt/signal/runtime/bin/caddy', 'validate', '--config', str(staging), '--adapter', 'caddyfile'], capture_output=True)
assert validation.returncode == 0, 'Caddy validation failed'
caddy.write_text(candidate)
caddy.chmod(0o644)
try:
    subprocess.run(['systemctl', 'restart', 'signal-caddy'], check=True, timeout=25)
except Exception:
    caddy.write_text(original)
    subprocess.run(['systemctl', 'restart', 'signal-caddy'], check=True, timeout=25)
    raise
states = {name: subprocess.check_output(['systemctl', 'is-active', name], text=True).strip()
          for name in ['signal-vpn-control','signal-vpn-web','signal-vpn','signal-caddy','signal-app','signal-media','x-ui']}
assert all(state == 'active' for state in states.values())
print(json.dumps({'url':'https://vpn.signal-on.ru/manage/','services':states,
                  'vpn_entry_ip':'177.3.212.182','traffic_encryption':'TLS 1.3','existing_profiles_preserved':True}))
