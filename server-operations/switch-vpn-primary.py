"""Move only the new Signal VPN to the owner's primary public IPv4.

Keeps existing device credentials and all unrelated VPN services unchanged.
"""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

PRIMARY = '177.3.212.182'
CONFIG = Path('/etc/signal-vpn/server.json')
BACKUP = Path('/root/signal-maint-20261026T181257Z')
assert BACKUP.is_dir()
actual_egress = subprocess.check_output(
    ['curl', '-4', '--interface', PRIMARY, '--fail', '--connect-timeout', '8',
     '--max-time', '15', '-sS', 'https://api.ipify.org'], text=True).strip()
assert actual_egress == PRIMARY, 'Primary egress did not verify'
original = json.loads(CONFIG.read_text())
assert original['inbounds'][0]['listen'] == '127.0.0.1'
assert original['inbounds'][0]['streamSettings']['network'] == 'xhttp'
candidate = json.loads(json.dumps(original))
candidate['outbounds'][0]['sendThrough'] = PRIMARY
candidate['outbounds'][0]['tag'] = 'direct-primary'
# Random per-request padding is provided by the established XHTTP transport.
# Keep its interoperable range instead of inventing a new crypto algorithm.
candidate['inbounds'][0]['streamSettings']['xhttpSettings']['xPaddingBytes'] = '100-1000'
assert candidate['inbounds'][0]['settings']['clients'] == original['inbounds'][0]['settings']['clients']
info = CONFIG.stat()
fd, temporary = tempfile.mkstemp(prefix='.primary-', suffix='.json', dir=CONFIG.parent)
try:
    with os.fdopen(fd, 'w') as output:
        output.write(json.dumps(candidate, indent=2) + '\n')
        output.flush()
        os.fsync(output.fileno())
    os.chown(temporary, info.st_uid, info.st_gid)
    os.chmod(temporary, info.st_mode & 0o777)
    check = subprocess.run(['runuser', '-u', 'signal-vpn', '--', '/opt/signal-vpn/xray',
                            'run', '-test', '-config', temporary], capture_output=True, text=True)
    assert check.returncode == 0, 'Candidate VPN configuration failed validation'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    shutil.copy2(CONFIG, BACKUP / ('vpn-before-primary-' + stamp + '.json'))
    os.replace(temporary, CONFIG)
    subprocess.run(['systemctl', 'restart', 'signal-vpn'], check=True)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
states = {unit: subprocess.check_output(['systemctl', 'is-active', unit], text=True).strip()
          for unit in ['signal-vpn', 'signal-caddy', 'signal-app', 'signal-media', 'x-ui']}
assert all(value == 'active' for value in states.values())
receipt = {'primary_ip': PRIMARY, 'vpn_entry': 'vpn.signal-on.ru:443',
           'vpn_exit': PRIMARY, 'padding_range': '100-1000', 'device_keys_preserved': True,
           'existing_xui_vpn_restarted': False, 'services': states}
(BACKUP / 'vpn-primary-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
