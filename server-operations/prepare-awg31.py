"""Pinned official AmneziaWG3.1 build, isolated from existing AWG deployments."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request
import zipfile

os.umask(0o022)
root = Path('/opt/signal-awg')
root.mkdir(mode=0o755,exist_ok=True)
source = root/'source'
revision = 'b5928efb6ca19f0153958460c3d141f04abc5c2e'
if not source.exists():
    with urllib.request.urlopen('https://codeload.github.com/amnezia-vpn/amneziawg-go/tar.gz/'+revision,timeout=40) as response:
        data = response.read(20*1024*1024)
    archive_hash = hashlib.sha256(data).hexdigest()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        members = archive.getmembers()
        prefix = members[0].name.split('/')[0]+'/'
        source.mkdir(mode=0o755)
        for member in members:
            if not member.name.startswith(prefix):
                continue
            member.name = member.name[len(prefix):]
            if member.name:
                archive.extract(member,source,filter='data')
    (root/'source-receipt.json').write_text(json.dumps({'protocol':'AmneziaWG3.1','tag':'v3.1.20260828',
        'revision':revision,'sourceArchiveSha256':archive_hash}))
    if 'header_protection_key' not in (source/'device/uapi.go').read_text():
        raise RuntimeError('Source missing required3.1 support')
tools = root/'awg'
if not tools.exists():
    url = 'https://github.com/amnezia-vpn/amneziawg-tools/releases/download/v3.1.20260812/ubuntu-22.04-amneziawg-tools.zip'
    with urllib.request.urlopen(url,timeout=40) as response:
        data = response.read(1024*1024)
    if hashlib.sha256(data).hexdigest() != '919e9d0a367c7c72f9c16b7d0a9e4840b943628353b2210a33cb4b582785ba56':
        raise RuntimeError('Official tools checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        selected = [name for name in archive.namelist() if name.rsplit('/',1)[-1]=='awg']
        if len(selected)!=1:
            raise RuntimeError('Unexpected tools archive')
        tools.write_bytes(archive.read(selected[0]))
    tools.chmod(0o755)
if subprocess.run(['sh','-c','command -v haproxy'],capture_output=True).returncode:
    env = os.environ.copy()
    env['DEBIAN_FRONTEND']='noninteractive'
    subprocess.run(['apt-get','update','-qq'],check=True,env=env,timeout=180)
    subprocess.run(['apt-get','install','-y','--no-install-recommends','haproxy'],check=True,env=env,timeout=180)
    subprocess.run(['systemctl','disable','--now','haproxy'],check=True)
    subprocess.run(['systemctl','reset-failed','haproxy'],check=False,capture_output=True)
subprocess.run(['docker','pull','golang:1.25'],check=True,timeout=240)
build = root/'build-native.sh'
build.write_text('''#!/bin/sh
set -eu
docker run --rm --name signal-awg-build --cpus=1 --memory=1536m --pids-limit=256 \\
  -e CGO_ENABLED=0 -e GOMAXPROCS=1 -e GOMEMLIMIT=1000MiB \\
  -v /opt/signal-awg/source:/src -w /src golang:1.25 \\
  go build -p 1 -trimpath -o /src/amneziawg-go .
install -m 755 /opt/signal-awg/source/amneziawg-go /opt/signal-awg/amneziawg-go
''')
build.chmod(0o700)
subprocess.run(['systemd-run','--unit=signal-awg-native-build','--property=Type=oneshot',str(build)],check=True)
print(json.dumps({'sourceReady':True,'tag':'v3.1.20260828','nativeBuildStarted':True,
    'netstackExamples':[str(path.relative_to(source)) for path in (source/'tun/netstack').rglob('*.go')],
    'existingVpnServicesUnchanged':True}))
