"""Update the owned VPS console with a same-server rollback snapshot."""
import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import time
import urllib.request

TARGET = Path('/opt/signal-vpn-web')
STATE = Path('/var/lib/signal-vpn-control/profiles.sqlite')
PACKAGE = Path('/root/signal-vpn-console-update.tar.gz')
FILES = {'app.py', 'control.py', 'advanced.py', 'web/index.html', 'web/app.js', 'web/style.css', 'web/vendor/qrcode.js'}
SERVICES = ['signal-vpn-control', 'signal-vpn-web', 'signal-vpn', 'signal-caddy', 'signal-app', 'signal-media', 'x-ui']


def service(*args):
    subprocess.run(['systemctl', *args], check=True, timeout=30)


def ready(check_schema=True):
    for _ in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3180/manage/api/session', timeout=2) as response:
                if json.load(response) != {'authenticated': False}:
                    raise RuntimeError('Unexpected web response')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(3)
                client.connect('/run/signal-vpn-control/control.sock')
                client.sendall(b'{"op":"list"}\n')
                with client.makefile('rb') as incoming:
                    result = json.loads(incoming.readline(131073))
            if result.get('ok') is not True or not isinstance(result.get('profiles'), list):
                raise RuntimeError('Controller not ready')
            if check_schema and any(profile.get('configuration') not in ('auto', 'packet-up', 'stream-up','tcp','udp') for profile in result['profiles']):
                raise RuntimeError('Controller schema not ready')
            if any(subprocess.run(['systemctl', 'is-active', '--quiet', name], timeout=5).returncode for name in SERVICES):
                raise RuntimeError('An existing service is not active')
            return
        except (OSError, ValueError, RuntimeError):
            pass
        time.sleep(.25)
    raise RuntimeError('Console did not become ready')


def main():
    os.umask(0o077)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/root') / ('signal-console-update-' + stamp)
    backup.mkdir(mode=0o700)
    staging = backup / 'candidate'
    staging.mkdir(mode=0o700)
    with tarfile.open(PACKAGE) as package:
        members = package.getmembers()
        if {member.name for member in members} != FILES or any(not member.isfile() for member in members):
            raise RuntimeError('Unexpected update contents')
        package.extractall(staging, filter='data')
    subprocess.run(['/usr/bin/python3', '-m', 'py_compile', str(staging / 'app.py'), str(staging / 'control.py')], check=True)
    new_files = []
    for relative in FILES:
        original = TARGET / relative
        if not original.exists():
            new_files.append(relative)
        elif not original.is_file() or original.is_symlink():
            raise RuntimeError('Unexpected existing deployment')
    try:
        service('stop', 'signal-vpn-web', 'signal-vpn-control')
        with tarfile.open(backup / 'source.tar.gz', 'w:gz') as archive:
            for relative in sorted(FILES):
                if relative not in new_files:
                    archive.add(TARGET / relative, arcname=relative)
        with sqlite3.connect(STATE) as source, sqlite3.connect(backup / 'profiles.sqlite') as destination:
            source.backup(destination)
        shutil.copy2('/etc/signal-vpn/server.json', backup / 'server.json')
        try:
            for relative in FILES:
                destination = TARGET / relative
                shutil.copyfile(staging / relative, destination)
                destination.chmod(0o644)
                os.chown(destination, 0, 0)
            service('start', 'signal-vpn-control')
            service('start', 'signal-vpn-web')
            ready()
        except Exception:
            service('stop', 'signal-vpn-web', 'signal-vpn-control')
            with tarfile.open(backup / 'source.tar.gz') as archive:
                archive.extractall(TARGET, filter='data')
            for relative in new_files:
                (TARGET / relative).unlink(missing_ok=True)
            for suffix in ('-wal', '-shm', '-journal'):
                Path(str(STATE) + suffix).unlink(missing_ok=True)
            shutil.copyfile(backup / 'profiles.sqlite', STATE)
            STATE.chmod(0o600)
            service('start', 'signal-vpn-control')
            service('start', 'signal-vpn-web')
            ready(check_schema=False)
            raise
    finally:
        service('start', 'signal-vpn-control')
        service('start', 'signal-vpn-web')
    states = {name: subprocess.check_output(['systemctl', 'is-active', name], text=True).strip() for name in SERVICES}
    if not all(value == 'active' for value in states.values()):
        raise RuntimeError('An existing service is not active')
    print(json.dumps({'updated': True, 'backup': str(backup), 'services': states}))


if __name__ == '__main__':
    main()
