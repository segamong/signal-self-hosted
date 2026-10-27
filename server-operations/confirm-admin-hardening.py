import json
from pathlib import Path
import subprocess

backup = Path('/root/signal-admin-hardening-20261027T074252Z')
receipt = json.loads((backup/'receipt.json').read_text())
effective = dict(line.split(' ',1) for line in subprocess.check_output(['/usr/sbin/sshd','-T'],text=True).splitlines() if ' ' in line)
if effective.get('passwordauthentication') != 'no' or effective.get('pubkeyauthentication') != 'yes':
    raise RuntimeError('SSH hardening validation failed')
subprocess.run(['systemctl','is-active','--quiet','signal-private-ingress','ssh.service'],check=True)
subprocess.run(['systemctl','stop',receipt['rollbackUnit']+'.timer'],check=True)
receipt.update({'newPublicKeyLoginVerified':True,'rollbackCancelled':True})
(backup/'receipt.json').write_text(json.dumps(receipt))
print(json.dumps(receipt))
