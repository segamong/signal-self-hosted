"""REALITY on primaryTCP443 with transparent SNI routing; keep genuine webHTTPS."""
import datetime
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import textwrap
import time
import urllib.parse

os.umask(0o077)
CONFIG=Path('/etc/signal-vpn/server.json')
CADDY=Path('/etc/signal/Caddyfile')
EDGE=Path('/etc/haproxy/signal.cfg')
UNIT=Path('/etc/systemd/system/signal-edge.service')
PUBLIC=Path('/etc/signal-vpn/reality-public.json')
if UNIT.exists() or PUBLIC.exists():
    raise RuntimeError('REALITY edge already exists; do not rotate identities')


def call(args,check=True):
    result=subprocess.run(args,capture_output=True,timeout=25)
    if check and result.returncode:
        if args[0].endswith(('caddy','haproxy')):
            print(re.sub(r'[a-f0-9]{48}','<path-redacted>',result.stderr.decode(errors='replace')),flush=True)
        raise RuntimeError('Server command failed: '+args[1])
    return result


def delta(line):
    # Only net brace depth is needed; Caddy placeholders have balanced braces.
    return line.split('#',1)[0].count('{')-line.split('#',1)[0].count('}')


def without_tls_policy(body):
    # One automation policy per hostname; the443 copy manages the same9443 certificate.
    output=[];lines=body.splitlines(keepends=True);index=0;depth=0
    while index<len(lines):
        line=lines[index]
        if depth==0 and line.strip() in ('import domain_tls','import public_tls'):
            index+=1
            continue
        if depth==0 and re.match(r'^\s*tls(?:\s|$)',line):
            tls_depth=delta(line);index+=1
            while tls_depth and index<len(lines):
                tls_depth+=delta(lines[index]);index+=1
            continue
        output.append(line);depth+=delta(line);index+=1
    return ''.join(output)


def caddy_candidate(before):
    lines=before.splitlines(keepends=True)
    result=[]
    index=0
    while index<len(lines):
        if not lines[index].strip() or lines[index].lstrip().startswith('#'):
            result.append(lines[index]);index+=1;continue
        start=index;depth=delta(lines[index]);index+=1
        if depth<=0:
            raise RuntimeError('Unexpected Caddy top-level syntax')
        while depth and index<len(lines):
            depth+=delta(lines[index]);index+=1
        if depth or lines[index-1].strip()!='}':
            raise RuntimeError('Unexpected Caddy block boundary')
        header=lines[start].strip()
        body=''.join(lines[start+1:index-1])
        if header=='{':
            result.append('{\n'+body+'''  servers 127.0.0.1:443 {
    protocols h1 h2
    listener_wrappers {
      proxy_protocol {
        timeout 1s
        allow 127.0.0.1/32
      }
      tls
    }
  }
  cert_issuer acme https://acme-v02.api.letsencrypt.org/directory {
    disable_tlsalpn_challenge
  }
}\n''')
            continue
        urls=[url.strip() for url in header[:-1].strip().split(',')]
        web=[url for url in urls if urllib.parse.urlsplit(url).scheme=='https' and (urllib.parse.urlsplit(url).port or 443)==443]
        other=[url for url in urls if url not in web]
        body=body.replace('  import domain_tls\n','')
        if web:
            result.append(', '.join(web)+' {\n  bind 127.0.0.1\n'+body+'}\n')
        if other:
            result.append(', '.join(other)+' {\n'+(without_tls_policy(body) if web else body)+'}\n')
    candidate=''.join(result)
    if candidate.count('forward_auth 127.0.0.1:3000')<before.count('forward_auth 127.0.0.1:3000'):
        raise RuntimeError('Admission guards missing')
    return candidate


def health():
    checks=[('vpn.signal-on.ru',443,'/manage/api/session','200'),
        ('signal-on.ru',443,'/api/health','200'),('panel.signal-on.ru',443,'/','302'),
        ('signal-on.ru',9443,'/api/health','200')]
    for host,port,path,expected in checks:
        address='https://'+host+(':'+str(port) if port!=443 else '')+path
        for attempt in range(20):
            response=call(['curl','--silent','--show-error','--output','/dev/null','--write-out','%{http_code}',
                '--max-time','2','--resolve',host+':'+str(port)+':177.3.212.182',address],False)
            result=response.stdout.decode()
            if response.returncode==0 and result==expected:
                break
            time.sleep(.25)
        else:
            print({'healthHost':host,'port':port,'status':result,'curlError':response.stderr.decode()[:300]},flush=True)
            raise RuntimeError('HTTPS health check failed: '+host+':'+str(port))


stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/root')/('signal-reality-edge-'+stamp)
backup.mkdir(mode=0o700)
call(['systemctl','stop','signal-vpn-web','signal-vpn-control'])
before=CONFIG.read_bytes();old_caddy=CADDY.read_bytes()
(backup/'server.json').write_bytes(before);(backup/'Caddyfile').write_bytes(old_caddy)
config=json.loads(before)
key_output=call(['/opt/signal-vpn/xray','x25519']).stdout.decode()
keys={re.sub('[^a-z]','',line.split(':',1)[0].lower()):line.split(':',1)[1].strip()
      for line in key_output.splitlines() if ':' in line}
private=keys.get('privatekey','');public=next((value for label,value in keys.items() if label.startswith('password') or label=='publickey'),'')
if not private or not public:
    call(['systemctl','start','signal-vpn-control','signal-vpn-web']);raise RuntimeError('REALITY key generation failed')
short_id=secrets.token_hex(8)
config['inbounds'].append({'tag':'signal-reality','listen':'127.0.0.1','port':39446,'protocol':'vless',
    'settings':{'clients':[],'decryption':'none'},'streamSettings':{'network':'tcp','security':'reality',
    'sockopt':{'acceptProxyProtocol':True,'tcpKeepAliveIdle':30,'tcpKeepAliveInterval':15},
    'realitySettings':{'show':False,'target':'www.microsoft.com:443','xver':0,
        'serverNames':['www.microsoft.com'],'privateKey':private,'shortIds':[short_id]}}})
new_caddy=caddy_candidate(old_caddy.decode())
staged_config=backup/'server.candidate.json';staged_config.write_text(json.dumps(config,indent=2)+'\n')
staged_caddy=backup/'Caddyfile.candidate';staged_caddy.write_text(new_caddy)
try:
    call(['/opt/signal-vpn/xray','run','-test','-config',str(staged_config)])
    adapted=json.loads(call(['/opt/signal/runtime/bin/caddy','adapt','--config',str(staged_caddy),'--adapter','caddyfile']).stdout)
    for server in adapted['apps']['http']['servers'].values():
        listens=server.get('listen',[])
        wrappers=[wrapper.get('wrapper') for wrapper in server.get('listener_wrappers',[])]
        if ':443' in listens or '0.0.0.0:443' in listens or '[::]:443' in listens:
            raise RuntimeError('Caddy still binds publicTCP443')
        if '127.0.0.1:443' in listens and 'proxy_protocol' not in wrappers:
            raise RuntimeError('Client-address forwarding missing')
        if any(address.endswith((':443',':9443')) for address in listens) and (not server.get('protocols') or 'h3' in server['protocols']):
            raise RuntimeError('HTTP3 must remain disabled to preserve AWG UDP443')
        if any(address.endswith(':9443') for address in listens) and 'proxy_protocol' in wrappers:
            raise RuntimeError('Public9443 must accept ordinaryTLS')
    call(['/opt/signal/runtime/bin/caddy','validate','--config',str(staged_caddy),'--adapter','caddyfile'])
    EDGE.write_text('''global
    maxconn 4096
defaults
    mode tcp
    timeout connect 10s
    timeout client 1h
    timeout server 1h
    option clitcpka
    option srvtcpka
frontend signal_tls
    bind 177.3.212.182:443
    bind 144.31.54.139:443
    tcp-request inspect-delay 5s
    tcp-request content accept if { req.ssl_hello_type 1 }
    use_backend reality if { req.ssl_sni -i www.microsoft.com }
    default_backend web_https
backend web_https
    server caddy 127.0.0.1:443 send-proxy-v2
backend reality
    server xray 127.0.0.1:39446 send-proxy-v2
''')
    EDGE.chmod(0o644)
    call(['/usr/sbin/haproxy','-c','-f',str(EDGE)])
except Exception:
    call(['systemctl','start','signal-vpn-control','signal-vpn-web']);raise
UNIT.write_text('''[Unit]
Description=Signal HTTPS and REALITY TCP443 SNI entry
After=network-online.target signal-caddy.service signal-vpn.service
Wants=network-online.target signal-caddy.service signal-vpn.service

[Service]
Type=simple
User=haproxy
Group=haproxy
ExecStart=/usr/sbin/haproxy -W -db -f /etc/haproxy/signal.cfg
Restart=on-failure
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=128M
TasksMax=64
LimitNOFILE=16384

[Install]
WantedBy=multi-user.target
''');UNIT.chmod(0o644)
rollback=backup/'rollback.py'
rollback.write_text(textwrap.dedent('''\
from pathlib import Path
import subprocess
backup=Path(BACKUP)
subprocess.run(['systemctl','disable','--now','signal-edge'],capture_output=True)
subprocess.run(['systemctl','stop','signal-vpn-web','signal-vpn-control','signal-caddy'],capture_output=True)
Path('/etc/signal-vpn/server.json').write_bytes((backup/'server.json').read_bytes())
Path('/etc/signal-vpn/server.json').chmod(0o640)
Path('/etc/signal/Caddyfile').write_bytes((backup/'Caddyfile').read_bytes())
Path('/etc/signal/Caddyfile').chmod(0o644)
Path('/etc/signal-vpn/reality-public.json').unlink(missing_ok=True)
Path('/etc/systemd/system/signal-edge.service').unlink(missing_ok=True)
Path('/etc/haproxy/signal.cfg').unlink(missing_ok=True)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','reset-failed','signal-caddy','signal-vpn-control','signal-vpn-web'],check=False)
subprocess.run(['systemctl','restart','signal-vpn'],check=True)
subprocess.run(['systemctl','start','signal-caddy','signal-vpn-control','signal-vpn-web'],check=True)
''').replace('BACKUP',repr(str(backup))))
timer='signal-reality-rollback-'+stamp.lower()
call(['systemd-run','--quiet','--unit',timer,'--on-active=180s','/usr/bin/python3','-I',str(rollback)])
try:
    CONFIG.write_text(json.dumps(config,indent=2)+'\n');CONFIG.chmod(0o640)
    PUBLIC.write_text(json.dumps({'publicKey':public,'shortId':short_id,'serverName':'www.microsoft.com'}));PUBLIC.chmod(0o600)
    call(['systemctl','stop','signal-caddy'])
    CADDY.write_text(new_caddy);CADDY.chmod(0o644)
    call(['systemctl','daemon-reload'])
    call(['systemctl','restart','signal-vpn'])
    call(['systemctl','start','signal-caddy'])
    call(['systemctl','enable','--now','signal-edge'])
    call(['systemctl','start','signal-vpn-control','signal-vpn-web'])
    health()
    call(['systemctl','stop',timer+'.timer'])
except Exception:
    subprocess.run(['/usr/bin/python3','-I',str(rollback)],check=True)
    call(['systemctl','stop',timer+'.timer']);raise
print(json.dumps({'realityTcp443':True,'webHttpsPreserved':True,'originalClientAddressesPreserved':True,
    'publicIp':'177.3.212.182','rollbackCancelled':True,'backup':str(backup)}))
