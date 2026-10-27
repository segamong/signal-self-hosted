"""Narrow administration hardening with a timed, same-server rollback."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import textwrap

os.umask(0o077)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/root') / ('signal-admin-hardening-' + stamp)
backup.mkdir(mode=0o700)
dropin = Path('/etc/ssh/sshd_config.d/00-00-signal-key-only.conf')
unit = Path('/etc/systemd/system/signal-private-ingress.service')
guard = Path('/usr/local/lib/signal-private-ingress.py')
if dropin.exists() or unit.exists() or guard.exists():
    raise RuntimeError('Hardening files already exist; inspect before replacing')
before = subprocess.check_output(['/usr/sbin/sshd','-T'],text=True)
if 'pubkeyauthentication yes' not in before:
    raise RuntimeError('Working public-key authentication not enabled')
panel_before = subprocess.check_output(['curl','--silent','--show-error','--output','/dev/null','--write-out','%{http_code}',
    '--resolve','panel.signal-on.ru:443:127.0.0.1','https://panel.signal-on.ru/'],text=True,timeout=10)
if panel_before not in ('200','302','303','307','308'):
    raise RuntimeError('Existing panel proxy not healthy')
(backup/'sshd-effective.before.txt').write_text(before)
guard.write_text(textwrap.dedent('''\
    import subprocess
    import sys
    rule = ['INPUT','!','-i','lo','-p','tcp','--dport','3429','-m','comment','--comment',
            'signal-admin-loopback-only','-j','REJECT','--reject-with','tcp-reset']
    for binary in ('/usr/sbin/iptables','/usr/sbin/ip6tables'):
        exists = subprocess.run([binary,'-w','10','-C',*rule],capture_output=True).returncode == 0
        if sys.argv[1] == 'apply' and not exists:
            subprocess.run([binary,'-w','10','-I','INPUT','1',*rule[1:]],check=True)
        elif sys.argv[1] == 'remove' and exists:
            subprocess.run([binary,'-w','10','-D',*rule],check=True)
    '''))
guard.chmod(0o644)
unit.write_text('''[Unit]
Description=Keep the proxied administration backend off public interfaces
After=network-pre.target
Before=x-ui.service

[Service]
Type=oneshot
RemainAfterExit=true
ExecStart=/usr/bin/python3 -I /usr/local/lib/signal-private-ingress.py apply
ExecStop=/usr/bin/python3 -I /usr/local/lib/signal-private-ingress.py remove
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
''')
unit.chmod(0o644)
rollback = backup/'rollback.py'
rollback.write_text(textwrap.dedent('''\
    from pathlib import Path
    import subprocess
    subprocess.run(['systemctl','disable','--now','signal-private-ingress'],capture_output=True)
    for item in ('/etc/ssh/sshd_config.d/00-00-signal-key-only.conf','/etc/systemd/system/signal-private-ingress.service','/usr/local/lib/signal-private-ingress.py'):
        Path(item).unlink(missing_ok=True)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['/usr/sbin/sshd','-t'],check=True)
    subprocess.run(['systemctl','reload','ssh.service'],check=True)
    '''))
rollback.chmod(0o600)
timer = 'signal-hardening-rollback-' + stamp.lower()
subprocess.run(['systemd-run','--quiet','--unit',timer,'--on-active=180s','/usr/bin/python3','-I',str(rollback)],check=True)
try:
    dropin.write_text('''# Key login verified before application; SSH tunnelling remains available.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
''')
    dropin.chmod(0o644)
    subprocess.run(['/usr/sbin/sshd','-t'],check=True,capture_output=True)
    effective = subprocess.check_output(['/usr/sbin/sshd','-T'],text=True)
    values = dict(line.split(' ',1) for line in effective.splitlines() if ' ' in line)
    if values.get('passwordauthentication') != 'no' or values.get('permitrootlogin') not in ('without-password','prohibit-password'):
        raise RuntimeError('SSH include precedence did not enforce key-only login')
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','signal-private-ingress'],check=True,capture_output=True)
    subprocess.run(['systemctl','reload','ssh.service'],check=True,capture_output=True)
    panel_after = subprocess.check_output(['curl','--silent','--show-error','--output','/dev/null','--write-out','%{http_code}',
        '--resolve','panel.signal-on.ru:443:127.0.0.1','https://panel.signal-on.ru/'],text=True,timeout=10)
    if panel_after != panel_before:
        raise RuntimeError('Panel proxy changed after ingress hardening')
except Exception:
    subprocess.run(['/usr/bin/python3','-I',str(rollback)],check=True)
    subprocess.run(['systemctl','stop',timer+'.timer'],check=True)
    raise
receipt = {'sshPasswordAuthentication':False,'sshPublicKeyAuthentication':True,
    'publicAdminPortBlocked':3429,'panelDomainStatus':panel_after,'backup':str(backup),'rollbackUnit':timer}
(backup/'receipt.json').write_text(json.dumps(receipt))
print(json.dumps(receipt))
