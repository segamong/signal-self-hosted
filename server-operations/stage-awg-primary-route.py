"""Stage a source-address route with a timed rollback; do not touch peers."""
import datetime,json,os,subprocess
from pathlib import Path

os.umask(0o077)
paths=[Path('/usr/local/lib/signal-awg-primary-route.py'),Path('/etc/systemd/system/signal-awg-primary-route.service'),
       Path('/etc/systemd/system/signal-awg.service.d/primary-route.conf')]
if any(p.exists() for p in paths):raise RuntimeError('An AWG routing setup already exists; inspect it')
rules=json.loads(subprocess.check_output(['ip','-4','-j','rule','show'],text=True))
if any(r.get('priority')==12377 for r in rules):raise RuntimeError('Routing priority already in use')
table=subprocess.run(['ip','-4','route','show','table','12377'],capture_output=True,text=True)
if table.returncode==0 and table.stdout.strip():raise RuntimeError('Routing table already in use')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/root')/('signal-awg-primary-route-'+stamp);backup.mkdir(mode=0o700)
rollback=backup/'rollback.py'
rollback.write_text('''import subprocess
from pathlib import Path
subprocess.run(['systemctl','stop','signal-awg-primary-route'],capture_output=True)
subprocess.run(['ip','-4','rule','del','priority','12377','iif','lo','ipproto','udp','sport','443','lookup','12377'],capture_output=True)
subprocess.run(['ip','-4','route','del','table','12377','default','via','10.0.0.1','dev','ens3','src','177.3.212.182','onlink'],capture_output=True)
for name in ['/etc/systemd/system/signal-awg.service.d/primary-route.conf','/etc/systemd/system/signal-awg-primary-route.service','/usr/local/lib/signal-awg-primary-route.py']:
 Path(name).unlink(missing_ok=True)
subprocess.run(['systemctl','daemon-reload'],capture_output=True)
subprocess.run(['systemctl','start','signal-awg'],capture_output=True)
''');rollback.chmod(0o600)
unit='signal-awg-route-rollback-'+stamp.lower()
subprocess.run(['systemd-run','--quiet','--unit',unit,'--on-active=240s','/usr/bin/python3','-I',str(rollback)],check=True)
try:
    subprocess.run(['ip','-4','route','add','table','12377','default','via','10.0.0.1','dev','ens3','src','177.3.212.182','onlink'],check=True)
    subprocess.run(['ip','-4','rule','add','priority','12377','iif','lo','ipproto','udp','sport','443','lookup','12377'],check=True)
    probe=subprocess.check_output(['ip','-4','route','get','1.1.1.1','ipproto','udp','sport','443'],text=True)
    if 'src 177.3.212.182' not in probe:raise RuntimeError('Policy route did not select the main address')
except Exception:
    subprocess.run(['/usr/bin/python3','-I',str(rollback)],check=True)
    subprocess.run(['systemctl','stop',unit+'.timer'],check=False)
    raise
print(json.dumps({'staged':True,'sourceAddressSelected':True,'rollbackUnit':unit,'backup':str(backup)}))
