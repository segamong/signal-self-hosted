import json
import os
from pathlib import Path
import subprocess
import tempfile

OLD = '13.143.172.92'
NEW = '177.3.212.182'

def atomic(path, text):
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

cert = Path('/var/lib/signal-caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory') / NEW / (NEW + '.crt')
subprocess.run(['openssl', 'x509', '-in', str(cert), '-noout', '-checkip', NEW, '-checkend', '21600'], check=True)
bridge = Path('/usr/local/lib/signal-xui-tls/sync.py')
original = bridge.read_text()
assert original.count(OLD) == 2
updated = original.replace(OLD, NEW)
compile(updated, str(bridge), 'exec')
subprocess.run(['systemctl', 'stop', 'signal-xui-tls.timer'], check=True)
try:
    atomic(bridge, updated)
    subprocess.run(['systemctl', 'start', 'signal-xui-tls.service'], check=True)
    receipt = json.loads(Path('/var/lib/signal-xui-tls/last-success.json').read_text())
    caddy = Path('/etc/signal/Caddyfile')
    text = caddy.read_text()
    assert text.count('tls_server_name ' + OLD) == 1
    text = text.replace('tls_server_name ' + OLD, 'tls_server_name ' + NEW)
    staged = Path('/etc/signal/Caddyfile.candidate')
    staged.write_text(text)
    staged.chmod(0o644)
    check = subprocess.run(['/opt/signal/runtime/bin/caddy', 'validate', '--config', str(staged), '--adapter', 'caddyfile'], capture_output=True)
    assert check.returncode == 0, check.stderr.decode()
    atomic(caddy, text)
    subprocess.run(['systemctl', 'restart', 'signal-caddy'], check=True)
finally:
    subprocess.run(['systemctl', 'start', 'signal-xui-tls.timer'], check=True)
print(json.dumps({'new_ip': NEW, 'panel_tls': receipt, 'vpn_restart_performed': False}))
