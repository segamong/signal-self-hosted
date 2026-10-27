import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import tarfile

os.umask(0o077)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
root = Path('/root') / ('signal-maint-' + stamp)
root.mkdir(mode=0o700)
snapshot = root / 'snapshot'
snapshot.mkdir(mode=0o700)
for source in ['/etc/signal', '/usr/local/lib/signal-xui-tls', '/root/cert/ip',
               '/var/lib/signal-caddy/caddy', '/etc/systemd/system/signal-app.service',
               '/etc/systemd/system/signal-media.service', '/etc/systemd/system/signal-caddy.service',
               '/etc/systemd/system/signal-xui-tls.service', '/etc/systemd/system/signal-xui-tls.timer']:
    path = Path(source)
    if not path.exists():
        continue
    target = snapshot / path.relative_to('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    if path.is_dir():
        shutil.copytree(path, target, symlinks=True)
    else:
        shutil.copy2(path, target)

database_checks = {}
for filename in ['/var/lib/signal/signal.sqlite', '/etc/x-ui/x-ui.db']:
    source = Path(filename)
    target = snapshot / source.relative_to('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
        with sqlite3.connect(target) as dst:
            src.backup(dst)
            database_checks[filename] = dst.execute('PRAGMA quick_check').fetchone()[0]
    target.chmod(0o600)
assert all(value == 'ok' for value in database_checks.values())

units = ['signal-app', 'signal-media', 'signal-caddy', 'x-ui']
inventory = {}
for unit in units:
    inventory[unit] = subprocess.check_output(
        ['systemctl', 'show', unit, '--property=MainPID,ActiveState,ExecMainStartTimestampMonotonic'],
        text=True).strip()
(root / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
archive = root / 'before-changes.tar'
with tarfile.open(archive, 'w') as output:
    output.add(snapshot, arcname='snapshot')
    output.add(root / 'inventory.json', arcname='inventory.json')
key = root / 'backup.key'
key.write_text(secrets.token_urlsafe(48) + '\n')
key.chmod(0o600)
encrypted = root / 'before-changes.tar.enc'
subprocess.run(['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
                '-in', str(archive), '-out', str(encrypted), '-pass', 'file:' + str(key)], check=True)
archive.unlink()
receipt = {'backup_root': str(root), 'encrypted_archive': str(encrypted),
           'bytes': encrypted.stat().st_size,
           'sha256': hashlib.sha256(encrypted.read_bytes()).hexdigest(),
           'sqlite_checks': database_checks, 'services': inventory}
(root / 'backup-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
