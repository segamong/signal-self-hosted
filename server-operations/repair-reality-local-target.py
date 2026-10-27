"""Align REALITY with the owner's existing TLS site; preserve keys and profiles."""
import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

os.umask(0o077)
CONFIG=Path('/etc/signal-vpn/server.json')
META=Path('/etc/signal-vpn/reality-public.json')
HAP=Path('/etc/haproxy/signal.cfg')


def call(args,timeout=25):
    result=subprocess.run(args,capture_output=True,timeout=timeout)
    if result.returncode:raise RuntimeError('Fixed validation/service command failed: '+args[0])
    return result.stdout


def health():
    for host,port,path,expected in [('vpn.signal-on.ru',443,'/manage/api/session','200'),
        ('signal-on.ru',443,'/api/health','200'),('panel.signal-on.ru',443,'/','302'),
        ('signal-on.ru',9443,'/api/health','200')]:
        deadline=time.monotonic()+25
        while time.monotonic()<deadline:
            result=subprocess.run(['curl','--silent','--show-error','--max-time','3','--output','/dev/null',
                '--write-out','%{http_code}','--resolve',f'{host}:{port}:177.3.212.182',
                f'https://{host}'+(f':{port}' if port!=443 else '')+path],capture_output=True,timeout=5)
            if not result.returncode and result.stdout.decode()==expected:break
            time.sleep(.5)
        else:
            print(json.dumps({'healthHost':host,'status':result.stdout.decode()[:3],
                'exitCode':result.returncode,'error':result.stderr.decode(errors='replace')[:250]}),flush=True)
            raise RuntimeError('Verified HTTPS health failed: '+host)


def verified_reality():
    def request(payload):
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
            client.settimeout(15);client.connect('/run/signal-vpn-control/control.sock')
            client.sendall(json.dumps(payload).encode()+b'\n')
            result=json.loads(client.makefile('rb').readline(131073))
        if not result.get('ok'):raise RuntimeError('Profile controller unavailable')
        return result
    row=next(p for p in request({'op':'list'})['profiles'] if p['active'] and p['name']=='T2 · V2RayTun REALITY')
    profile=request({'op':'get','id':row['id']})['profile']
    config=profile['clientConfig'];config['inbounds'][0]['port']=19283
    with tempfile.TemporaryDirectory(prefix='signal-reality-check-',dir='/root') as directory:
        path=Path(directory)/'client.json';path.write_text(json.dumps(config));path.chmod(0o600)
        process=subprocess.Popen(['/opt/signal-vpn/xray','run','-config',str(path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            for _ in range(40):
                if process.poll() is not None:raise RuntimeError('Diagnostic client could not start')
                try:
                    with socket.create_connection(('127.0.0.1',19283),timeout=.2):break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('Diagnostic client not ready')
            result=subprocess.run(['curl','--silent','--show-error','--fail','--max-time','18',
                '--noproxy','','--proxy','socks5h://127.0.0.1:19283','https://api.ipify.org'],capture_output=True,timeout=22)
            if result.returncode or result.stdout.strip()!=b'177.3.212.182':
                raise RuntimeError('Encrypted REALITY internet check failed')
        finally:
            process.terminate()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)


health()
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/root')/('signal-reality-local-target-'+stamp);backup.mkdir(mode=0o700)
config=json.loads(CONFIG.read_text());meta=json.loads(META.read_text());hap=HAP.read_text()
inbound=next(i for i in config['inbounds'] if i.get('streamSettings',{}).get('security')=='reality')
settings=inbound['streamSettings']['realitySettings']
if meta['serverName']!='www.microsoft.com' or 'req.ssl_sni -i www.microsoft.com' not in hap:
    raise RuntimeError('Unexpected existing SNI; inspect before changing')
old={key:settings.get(key) for key in ['target','serverNames','xver']}
for path in [CONFIG,META,HAP]:shutil.copy2(path,backup/path.name)
rollback=backup/'rollback.py'
rollback.write_text('''import json,subprocess
from pathlib import Path
backup=Path(BACKUP)
subprocess.run(['systemctl','stop','signal-vpn-control'],check=True)
path=Path('/etc/signal-vpn/server.json');config=json.loads(path.read_text())
inbound=next(i for i in config['inbounds'] if i.get('streamSettings',{}).get('security')=='reality')
inbound['streamSettings']['realitySettings'].update(OLD)
path.write_text(json.dumps(config,indent=2)+'\\n');path.chmod(0o640)
Path('/etc/signal-vpn/reality-public.json').write_bytes((backup/'reality-public.json').read_bytes())
Path('/etc/haproxy/signal.cfg').write_bytes((backup/'signal.cfg').read_bytes())
subprocess.run(['systemctl','restart','signal-vpn','signal-edge'],check=True)
subprocess.run(['systemctl','start','signal-vpn-control','signal-vpn-web'],check=True)
'''.replace('BACKUP',repr(str(backup))).replace('OLD',repr(old)))
rollback.chmod(0o600)
settings.update(target='127.0.0.1:443',serverNames=['vpn.signal-on.ru'],xver=2)
meta['serverName']='vpn.signal-on.ru'
hap=hap.replace('req.ssl_sni -i www.microsoft.com','req.ssl_sni -i vpn.signal-on.ru')
candidate=backup/'server.candidate.json';candidate.write_text(json.dumps(config,indent=2)+'\n')
hap_candidate=backup/'haproxy.candidate.cfg';hap_candidate.write_text(hap)
call(['/opt/signal-vpn/xray','run','-test','-config',str(candidate)])
call(['/usr/sbin/haproxy','-c','-f',str(hap_candidate)])
timer='signal-local-target-rollback-'+stamp.lower()
call(['systemd-run','--quiet','--unit',timer,'--on-active=180s','/usr/bin/python3','-I',str(rollback)])
try:
    call(['systemctl','stop','signal-vpn-control'])
    # Re-read the live clients after stopping the controller; preserve any
    # profile added during candidate validation.
    fresh=json.loads(CONFIG.read_text())
    real=next(i for i in fresh['inbounds'] if i.get('streamSettings',{}).get('security')=='reality')
    real['streamSettings']['realitySettings'].update(target='127.0.0.1:443',serverNames=['vpn.signal-on.ru'],xver=2)
    CONFIG.write_text(json.dumps(fresh,indent=2)+'\n');CONFIG.chmod(0o640)
    META.write_text(json.dumps(meta));META.chmod(0o600)
    HAP.write_text(hap);HAP.chmod(0o644)
    call(['systemctl','restart','signal-vpn','signal-edge'])
    call(['systemctl','start','signal-vpn-control','signal-vpn-web'])
    health()
    verified_reality()
    call(['systemctl','stop',timer+'.timer'])
except Exception:
    call(['/usr/bin/python3','-I',str(rollback)])
    call(['systemctl','stop',timer+'.timer'])
    raise
receipt={'localTlsTarget':True,'sni':'vpn.signal-on.ru','httpsVerified':True,'realityInternetVerified':True,
    'keysAndProfileIdsPreserved':True,'originalClientAddressesPreserved':True,
    'rollbackCancelled':True,'backup':str(backup)}
(backup/'receipt.json').write_text(json.dumps(receipt))
print(json.dumps(receipt))
