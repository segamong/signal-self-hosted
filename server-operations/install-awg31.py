import json
import os
from pathlib import Path
import socket
import subprocess

os.umask(0o077)
directory=Path('/etc/signal-awg')
if directory.exists():
    raise RuntimeError('AWG setup already exists; inspect before replacing keys')
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as probe:
    probe.bind(('0.0.0.0',443))
if Path('/proc/sys/net/ipv4/ip_forward').read_text().strip()!='1':
    raise RuntimeError('Existing host forwarding not enabled')
binary='/opt/signal-awg/awg'
def key(operation,input=None):
    return subprocess.check_output([binary,operation],input=input).decode().strip()
private=key('genkey')
public=key('pubkey',(private+'\n').encode())
obfuscation={'Jc':4,'Jmin':40,'Jmax':80,'S1':128,'S2':64,'S3':16,'S4':16,
    'H1':1,'H2':2,'H3':3,'H4':4,'HeaderProtectionKey':key('genpsk'),
    'ContentPaddingAddition':'16-48','RekeyAfterTime':'110-150','RekeyTimeout':'4-8',
    'RejectAfterTime':'180-240','KeepaliveTimeout':'15-25','MaxHandshakeAttempts':'10-15'}
directory.mkdir(mode=0o700)
(directory/'metadata.json').write_text(json.dumps({'version':'3.1','sourceTag':'v3.1.20260828',
    'publicKey':public,'endpoint':'177.3.212.182:443','obfuscation':obfuscation},indent=2))
(directory/'server.conf').write_text('[Interface]\nPrivateKey = '+private+'\nListenPort = 443\n'+
    '\n'.join(key+' = '+str(value) for key,value in obfuscation.items())+'\n')
(directory/'metadata.json').chmod(0o600)
(directory/'server.conf').chmod(0o600)
unit=Path('/etc/systemd/system/signal-awg.service')
unit.write_text('''[Unit]
Description=Signal AmneziaWG3.1 isolated userspace tunnel
After=network-online.target docker.service
Wants=network-online.target
Before=signal-vpn-control.service

[Service]
Type=simple
User=root
Group=root
Environment=WG_PROCESS_FOREGROUND=1
Environment=LOG_LEVEL=error
Environment=GOMAXPROCS=2
ExecStart=/opt/signal-awg/amneziawg-go -f awg-signal
ExecStartPost=/usr/bin/python3 -I /opt/signal-awg/awg-lifecycle.py start
ExecStopPost=/usr/bin/python3 -I /opt/signal-awg/awg-lifecycle.py stop
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
MemoryMax=256M
TasksMax=128
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
''')
unit.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','signal-awg'],check=True,timeout=25)
subprocess.run(['systemctl','is-active','--quiet','signal-awg'],check=True)
print(json.dumps({'awg31Started':True,'sourceTag':'v3.1.20260828','publicUdpPort':443,
    'mtu':1280,'existingAwgInterfacesUnchanged':True}))
