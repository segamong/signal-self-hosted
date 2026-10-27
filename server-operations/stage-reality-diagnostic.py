"""Temporarily collect only inbound byte counters, with automatic rollback."""
import datetime,json,os,subprocess,tempfile,time
from pathlib import Path
os.umask(0o077)
path=Path('/etc/signal-vpn/server.json')
original=json.loads(path.read_text())
if any(k in original for k in ('api','stats','policy')):raise RuntimeError('Existing diagnostics require inspection')
backup=Path('/root')/('signal-reality-diag-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(mode=0o700)
rollback=backup/'rollback.py'
rollback.write_text('''import json,os,subprocess,tempfile
from pathlib import Path
p=Path('/etc/signal-vpn/server.json')
subprocess.run(['systemctl','stop','signal-vpn-control'],capture_output=True)
c=json.loads(p.read_text())
if c.get('api',{}).get('tag')=='signal-mobile-diagnostic':
 c.pop('api',None);c.pop('stats',None);c.pop('policy',None)
 info=p.stat();fd,tmp=tempfile.mkstemp(prefix='.diag-restore-',dir=p.parent)
 with os.fdopen(fd,'w') as f:json.dump(c,f,indent=2);f.write('\\n');f.flush();os.fsync(f.fileno())
 os.chown(tmp,info.st_uid,info.st_gid);os.chmod(tmp,info.st_mode & 0o777);os.replace(tmp,p)
 subprocess.run(['systemctl','restart','signal-vpn'],check=True)
subprocess.run(['systemctl','start','signal-vpn-control','signal-vpn-web'],check=True)
''');rollback.chmod(0o600)
candidate=dict(original)
candidate['api']={'tag':'signal-mobile-diagnostic','listen':'127.0.0.1:39450','services':['StatsService']}
candidate['stats']={}
candidate['policy']={'system':{'statsInboundUplink':True,'statsInboundDownlink':True}}
candidate_file=backup/'candidate.json';candidate_file.write_text(json.dumps(candidate));candidate_file.chmod(0o600)
subprocess.run(['/opt/signal-vpn/xray','run','-test','-config',str(candidate_file)],check=True,capture_output=True,timeout=20)
unit='signal-reality-diag-rollback-'+backup.name.rsplit('-',1)[1].lower()
subprocess.run(['systemd-run','--quiet','--unit',unit,'--on-active=300s','/usr/bin/python3','-I',str(rollback)],check=True)
try:
    subprocess.run(['systemctl','stop','signal-vpn-control'],check=True,timeout=20)
    fresh=json.loads(path.read_text())
    if any(k in fresh for k in ('api','stats','policy')):raise RuntimeError('Settings changed during validation')
    fresh.update({k:candidate[k] for k in ('api','stats','policy')})
    info=path.stat();fd,tmp=tempfile.mkstemp(prefix='.diag-',dir=path.parent)
    with os.fdopen(fd,'w') as f:json.dump(fresh,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    os.chown(tmp,info.st_uid,info.st_gid);os.chmod(tmp,info.st_mode&0o777);os.replace(tmp,path)
    subprocess.run(['systemctl','restart','signal-vpn'],check=True,timeout=25)
    subprocess.run(['systemctl','start','signal-vpn-control','signal-vpn-web'],check=True,timeout=25)
    for i in range(25):
        r=subprocess.run(['/opt/signal-vpn/xray','api','statsquery','--server=127.0.0.1:39450','-pattern','inbound>>>signal-reality>>>traffic>>>'],capture_output=True,text=True,timeout=3)
        if r.returncode==0:break
        time.sleep(.2)
    else:raise RuntimeError('Counter API did not become ready')
except Exception:
    subprocess.run(['/usr/bin/python3','-I',str(rollback)],check=True)
    subprocess.run(['systemctl','stop',unit+'.timer'],check=False)
    raise
print(json.dumps({'temporaryCountersEnabled':True,'userTrafficContentLogged':False,'rollbackUnit':unit,'backup':str(backup)}))
