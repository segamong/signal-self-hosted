"""Transactional same-host deployment: actual protocols behind existing HTTPS443."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import time
import urllib.request

os.umask(0o077)
TARGET = Path('/opt/signal-vpn-web')
STATE = Path('/var/lib/signal-vpn-control/profiles.sqlite')
CONFIG = Path('/etc/signal-vpn/server.json')
CADDY = Path('/etc/signal/Caddyfile')
FILES = {'app.py','control.py','web/index.html','web/app.js','web/style.css','web/vendor/qrcode.js'}
PORTS = {'trojan':39444,'vmess':39445}
SERVICES = ['signal-vpn-control','signal-vpn-web','signal-vpn','signal-caddy','signal-app','signal-media','x-ui']


def systemctl(*args):
    subprocess.run(['systemctl',*args],check=True,capture_output=True,timeout=30)


def write_config(file, data, original_info):
    temporary = file.with_name(file.name + '.protocol-candidate')
    temporary.write_bytes(data)
    temporary.chmod(original_info.st_mode & 0o777)
    os.chown(temporary, original_info.st_uid, original_info.st_gid)
    os.replace(temporary,file)


def ready(expected):
    for attempt in range(50):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3180/manage/api/session',timeout=2) as response:
                if json.load(response) != {'authenticated':False}:
                    raise RuntimeError('Unexpected web response')
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
                connection.settimeout(3)
                connection.connect('/run/signal-vpn-control/control.sock')
                connection.sendall(b'{"op":"status"}\n')
                with connection.makefile('rb') as incoming:
                    result = json.loads(incoming.readline(131073))
            if not result.get('ok') or not result['status']['online']:
                raise RuntimeError('Controller not ready')
            if expected and set(result['status'].get('protocols',[])) != {'vless','trojan','vmess'}:
                raise RuntimeError('Expected protocols not ready')
            return
        except (OSError,ValueError,RuntimeError):
            if attempt == 49:
                raise
            time.sleep(.2)


def main():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/root') / ('signal-protocols-' + stamp)
    backup.mkdir(mode=0o700)
    staging = backup / 'source'
    staging.mkdir(mode=0o700)
    with tarfile.open('/root/vpn-console-protocols.tar.gz') as archive:
        if {member.name for member in archive.getmembers()} != FILES or any(not member.isfile() for member in archive.getmembers()):
            raise RuntimeError('Unexpected source archive')
        archive.extractall(staging,filter='data')
    subprocess.run(['/usr/bin/python3','-m','py_compile',str(staging/'app.py'),str(staging/'control.py')],check=True)
    before = CONFIG.read_bytes()
    caddy_before = CADDY.read_bytes()
    config_info = CONFIG.stat()
    caddy_info = CADDY.stat()
    candidate = json.loads(before)
    if [inbound['protocol'] for inbound in candidate['inbounds']] != ['vless']:
        raise RuntimeError('Protocol deployment already applied or unexpected configuration')
    original_clients = candidate['inbounds'][0]['settings']['clients'].copy()
    if candidate['outbounds'][0]['sendThrough'] != '177.3.212.182':
        raise RuntimeError('Unexpected exit IP')
    routes = ''
    for protocol,port in PORTS.items():
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',port))
        path = '/' + secrets.token_hex(24)
        settings = {'clients':[]}
        if protocol == 'vmess':
            settings['disableInsecureEncryption'] = True
        candidate['inbounds'].append({'tag':'signal-'+protocol+'-xhttp','listen':'127.0.0.1','port':port,
            'protocol':protocol,'settings':settings,'streamSettings':{'network':'xhttp','security':'none',
            'xhttpSettings':{'path':path,'mode':'auto','xPaddingBytes':'100-1000'}}})
        routes += ('  @vpn_'+protocol+' path '+path+' '+path+'/*\n  handle @vpn_'+protocol+
                   ' {\n    reverse_proxy h2c://127.0.0.1:'+str(port)+'\n  }\n')
    caddy_text = caddy_before.decode()
    needle = '  @vpn_stream path '
    if caddy_text.count(needle) != 1 or caddy_text.count('forward_auth 127.0.0.1:3000') != 2:
        raise RuntimeError('Unexpected Caddy route layout')
    caddy_candidate = caddy_text.replace(needle,routes+needle,1).encode()
    if 'protocols tls1.3' not in caddy_candidate.decode() or '@vpn_manage' not in caddy_candidate.decode():
        raise RuntimeError('TLS or console route missing')
    vpn_staging = CONFIG.with_name('server.protocol-candidate.json')
    caddy_staging = CADDY.with_name('Caddyfile.protocol-candidate')
    vpn_staging.write_text(json.dumps(candidate,indent=2)+'\n')
    caddy_staging.write_bytes(caddy_candidate)
    vpn_staging.chmod(0o600)
    caddy_staging.chmod(0o600)
    validation = subprocess.run(['/opt/signal-vpn/xray','run','-test','-config',str(vpn_staging)],capture_output=True,timeout=15)
    if validation.returncode:
        raise RuntimeError('Xray rejected protocol configuration')
    validation = subprocess.run(['/opt/signal/runtime/bin/caddy','validate','--config',str(caddy_staging),'--adapter','caddyfile'],capture_output=True,timeout=20)
    if validation.returncode:
        raise RuntimeError('Caddy rejected protocol routes')
    for protocol in PORTS:
        if candidate['inbounds'][0]['settings']['clients'] != original_clients:
            raise RuntimeError('Existing clients changed unexpectedly')
    reloadable = subprocess.check_output(['systemctl','show','-p','CanReload','--value','signal-caddy'],text=True).strip() == 'yes'
    caddy_operation = 'reload' if reloadable else 'restart'
    try:
        systemctl('stop','signal-vpn-web','signal-vpn-control')
        (backup/'server.json').write_bytes(before)
        (backup/'Caddyfile').write_bytes(caddy_before)
        with tarfile.open(backup/'console.tar.gz','w:gz') as archive:
            for name in sorted(FILES):
                archive.add(TARGET/name,arcname=name)
        with sqlite3.connect(STATE) as source, sqlite3.connect(backup/'profiles.sqlite') as destination:
            source.backup(destination)
        try:
            for name in FILES:
                shutil.copyfile(staging/name,TARGET/name)
                (TARGET/name).chmod(0o644)
                os.chown(TARGET/name,0,0)
            write_config(CONFIG,(json.dumps(candidate,indent=2)+'\n').encode(),config_info)
            write_config(CADDY,caddy_candidate,caddy_info)
            systemctl('restart','signal-vpn')
            systemctl(caddy_operation,'signal-caddy')
            systemctl('start','signal-vpn-control','signal-vpn-web')
            ready(True)
            for name in SERVICES:
                systemctl('is-active','--quiet',name)
        except Exception:
            systemctl('stop','signal-vpn-web','signal-vpn-control')
            write_config(CONFIG,before,config_info)
            write_config(CADDY,caddy_before,caddy_info)
            with tarfile.open(backup/'console.tar.gz') as archive:
                archive.extractall(TARGET,filter='data')
            for suffix in ('-wal','-shm','-journal'):
                Path(str(STATE)+suffix).unlink(missing_ok=True)
            shutil.copyfile(backup/'profiles.sqlite',STATE)
            STATE.chmod(0o600)
            systemctl('restart','signal-vpn')
            systemctl(caddy_operation,'signal-caddy')
            systemctl('start','signal-vpn-control','signal-vpn-web')
            ready(False)
            raise
    finally:
        systemctl('start','signal-vpn-control','signal-vpn-web')
        vpn_staging.unlink(missing_ok=True)
        caddy_staging.unlink(missing_ok=True)
    print(json.dumps({'deployed':True,'protocols':['vless','trojan','vmess'],'publicVpnPort':443,
        'newPublicPorts':[],'previousProfilesPreserved':True,'backup':str(backup)}))


if __name__ == '__main__':
    main()
