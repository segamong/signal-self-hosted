"""Persist the tested scoped route; retain the timed rollback until re-tested."""
import json,os,shutil,socket,subprocess
from pathlib import Path

os.umask(0o077)
timer='signal-awg-route-rollback-20261027t171915z.timer'
backup=Path('/root/signal-awg-primary-route-20261027T171915Z')
if subprocess.run(['systemctl','is-active','--quiet',timer]).returncode:raise RuntimeError('Temporary rollback expired')
helper=Path('/usr/local/lib/signal-awg-primary-route.py')
unit=Path('/etc/systemd/system/signal-awg-primary-route.service')
dropin=Path('/etc/systemd/system/signal-awg.service.d/primary-route.conf')
if any(p.exists() for p in [helper,unit,dropin]):raise RuntimeError('Unexpected existing routing files')
try:
    shutil.copyfile('/root/awg-primary-route.py',helper);helper.chmod(0o644)
    unit.write_text('''[Unit]
Description=Use the primary address for Signal AWG UDP replies
After=network-online.target
Wants=network-online.target
Before=signal-awg.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 -I /usr/local/lib/signal-awg-primary-route.py apply
ExecStop=/usr/bin/python3 -I /usr/local/lib/signal-awg-primary-route.py remove
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_NET_ADMIN
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
''');unit.chmod(0o644)
    dropin.parent.mkdir(mode=0o755,exist_ok=True)
    dropin.write_text('[Unit]\nRequires=signal-awg-primary-route.service\nAfter=signal-awg-primary-route.service\n');dropin.chmod(0o644)
    subprocess.run(['systemctl','daemon-reload'],check=True,timeout=20)
    subprocess.run(['systemctl','enable','--now','signal-awg-primary-route'],check=True,capture_output=True,timeout=25)
    subprocess.run(['systemctl','restart','signal-awg'],check=True,capture_output=True,timeout=30)
    subprocess.run(['systemctl','is-active','--quiet','signal-awg','signal-awg-primary-route'],check=True)
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(5);s.connect('/var/run/amneziawg/awg-signal.sock');s.sendall(b'get=1\n\n');data=b''
        while not data.endswith(b'\n\n'):data+=s.recv(65536)
    if b'errno=0' not in data or b'public_key=' not in data:raise RuntimeError('AWG peers were not restored')
except Exception:
    subprocess.run(['/usr/bin/python3','-I',str(backup/'rollback.py')],check=True)
    subprocess.run(['systemctl','stop',timer],check=False)
    raise
print(json.dumps({'routeServiceEnabled':True,'awgRestarted':True,'existingPeersRestored':True,'rollbackStillArmed':True}))
