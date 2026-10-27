import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess

os.umask(0o077)
BACKUP = Path('/root/signal-maint-20261026T181257Z')
assert (BACKUP / 'before-changes.tar.enc').is_file()
source = BACKUP / 'vpn-server.json'
config = json.loads(source.read_text(encoding='utf-8-sig'))
assert config['inbounds'][0]['listen'] == '127.0.0.1'
assert config['inbounds'][0]['port'] == 39443
assert len(config['inbounds'][0]['settings']['clients']) == 2
tunnel_path = config['inbounds'][0]['streamSettings']['xhttpSettings']['path']
assert len(tunnel_path) == 49 and tunnel_path.startswith('/')
assert all(c in '0123456789abcdef' for c in tunnel_path[1:])
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 39443))
assert not Path('/etc/systemd/system/signal-vpn.service').exists()
if Path('/etc/signal-vpn/server.json').exists():
    assert json.loads(Path('/etc/signal-vpn/server.json').read_text()) == config
try:
    pwd.getpwnam('signal-vpn')
except KeyError:
    subprocess.run(['useradd', '--system', '--user-group', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'signal-vpn'], check=True)
identity = pwd.getpwnam('signal-vpn')
directory = Path('/etc/signal-vpn')
directory.mkdir(mode=0o750, exist_ok=True)
directory.chmod(0o750)
os.chown(directory, 0, identity.pw_gid)
server_config = directory / 'server.json'
server_config.write_text(json.dumps(config, indent=2) + '\n')
server_config.chmod(0o640)
os.chown(server_config, 0, identity.pw_gid)
runtime = Path('/opt/signal-vpn')
runtime.mkdir(mode=0o755, exist_ok=True)
runtime.chmod(0o755)
binary = runtime / 'xray'
shutil.copy2('/usr/local/x-ui/bin/xray-linux-amd64', binary)
os.chown(binary, 0, 0)
binary.chmod(0o755)
validation = subprocess.run(['runuser', '-u', 'signal-vpn', '--', str(binary), 'run', '-test', '-config', str(server_config)], capture_output=True, text=True)
if validation.returncode:
    print(validation.stdout)
    print(validation.stderr)
    raise SystemExit('Xray config test failed; service not installed')
unit = '''[Unit]
Description=Signal private VPN over XHTTP and HTTPS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=signal-vpn
Group=signal-vpn
ExecStart=/opt/signal-vpn/xray run -config /etc/signal-vpn/server.json
Restart=on-failure
RestartSec=3
UMask=0077
CPUQuota=80%
CPUWeight=20
MemoryMax=256M
TasksMax=128
LimitNOFILE=8192
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

[Install]
WantedBy=multi-user.target
'''
unit_path = Path('/etc/systemd/system/signal-vpn.service')
unit_path.write_text(unit)
unit_path.chmod(0o644)

caddy = Path('/etc/signal/Caddyfile')
original = caddy.read_text()
assert 'https://vpn.signal-on.ru' not in original
shutil.copy2(caddy, BACKUP / 'Caddyfile.before-vpn')
block = '''
# Dedicated VPN vhost; Signal routes and admission checks remain in their own hosts.
https://vpn.signal-on.ru {
  tls {
    protocols tls1.3
    issuer acme https://acme-v02.api.letsencrypt.org/directory {
      disable_tlsalpn_challenge
    }
  }
  @vpn_stream path __PATH__ __PATH__/*
  handle @vpn_stream {
    reverse_proxy 127.0.0.1:39443
  }
  handle {
    respond "Not Found" 404
  }
}

http://vpn.signal-on.ru {
  redir https://{host}{uri} 308
}
'''.replace('__PATH__', tunnel_path)
candidate = original.rstrip() + '\n' + block
staged = Path('/etc/signal/Caddyfile.candidate')
staged.write_text(candidate)
staged.chmod(0o644)
check = subprocess.run(['/opt/signal/runtime/bin/caddy', 'validate', '--config', str(staged), '--adapter', 'caddyfile'], capture_output=True)
assert check.returncode == 0, check.stderr.decode()
assert candidate.count('forward_auth 127.0.0.1:3000') == 2
dropin_dir = Path('/etc/systemd/system/signal-caddy.service.d')
dropin_dir.mkdir(exist_ok=True)
dropin = dropin_dir / 'vpn-resources.conf'
assert not dropin.exists()
dropin.write_text('[Service]\nCPUQuota=100%\nMemoryMax=256M\nTasksMax=256\n')
dropin.chmod(0o644)
caddy.write_text(candidate)
caddy.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'signal-vpn.service'], check=True)
subprocess.run(['systemctl', 'restart', 'signal-caddy.service'], check=True)
states = {name: subprocess.check_output(['systemctl', 'is-active', name], text=True).strip()
          for name in ['signal-vpn', 'signal-caddy', 'signal-app', 'signal-media', 'x-ui']}
assert all(value == 'active' for value in states.values())
receipt = {'host': 'vpn.signal-on.ru', 'port': 443, 'protocol': 'VLESS/XHTTP/TLS1.3',
           'backend': '127.0.0.1:39443', 'egress': config['outbounds'][0]['sendThrough'], 'device_profiles': 2,
           'services': states, 'xray_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
           'existing_vpn_restart_performed': False}
(BACKUP / 'vpn-install-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
