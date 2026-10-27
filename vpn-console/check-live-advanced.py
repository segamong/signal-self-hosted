"""Real encrypted connections; per-socket physical routing, no OS/VPN route changes."""
import base64
import contextlib
import copy
import datetime
import http.client
import http.cookiejar
import io
import json
from pathlib import Path
import select
import socket
import socketserver
import ssl
import struct
import sys
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parent.parent
PRIVATE=ROOT/'server-operations/private'
HOST='vpn.signal-on.ru';PRIMARY='177.3.212.182';BASE='https://'+HOST
XRAY=ROOT/'server-operations/vendor/xray-26.9.9/xray.exe'
PROBE=ROOT/'server-operations/vendor/awg-probe.exe'
LOCAL_IP=subprocess.check_output(['powershell.exe','-NoProfile','-Command',
    "(Get-NetIPAddress -InterfaceIndex 4 -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred' | Select-Object -First 1).IPAddress"],
    text=True,creationflags=subprocess.CREATE_NO_WINDOW).strip()
csrf='';created=[];pools=[];report={}


def physical(kind=socket.SOCK_STREAM):
    result=socket.socket(socket.AF_INET,kind);result.settimeout(15)
    if not (kind==socket.SOCK_DGRAM and '--system-udp' in sys.argv):
        result.setsockopt(socket.IPPROTO_IP,31,struct.pack('!I',4));result.bind((LOCAL_IP,0))
    result.connect((PRIMARY,443));return result


class Connection(http.client.HTTPSConnection):
    def connect(self):
        if self.host!=HOST:raise RuntimeError('Unexpected HTTPS destination')
        self.sock=self._context.wrap_socket(physical(),server_hostname=HOST)


class Handler(urllib.request.HTTPSHandler):
    def https_open(self,request):
        return self.do_open(Connection,request,context=ssl.create_default_context())


opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),Handler(),
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
public=urllib.request.build_opener(urllib.request.ProxyHandler({}),Handler())


def fetch(path,method='GET',data=None,authenticated=True):
    headers={'Accept':'application/json'}
    if data is not None:headers.update({'Origin':BASE,'Content-Type':'application/json','X-CSRF-Token':csrf})
    request=urllib.request.Request(BASE+path,headers=headers,method=method,
        data=json.dumps(data).encode() if data is not None else None)
    for attempt in range(3):
        try:
            with (opener if authenticated else public).open(request,timeout=35) as response:
                body=response.read(2*1024*1024)
                return json.loads(body) if response.headers.get('Content-Type','').startswith('application/json') else body
        except urllib.error.HTTPError:raise
        except (OSError,urllib.error.URLError):
            if method not in ('GET','DELETE') or attempt==2:raise
            time.sleep(.3)


def api(path,method='GET',data=None):return fetch('/manage/api/'+path,method,data)


class TCPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with physical() as remote:
                remote.settimeout(None)
                sockets=[self.request,remote]
                while True:
                    readable,_,_=select.select(sockets,[],[],30)
                    if not readable:continue
                    for source in readable:
                        data=source.recv(65536)
                        if not data:return
                        (remote if source is self.request else self.request).sendall(data)
        except OSError:pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True;daemon_threads=True


class UDPBridge:
    def __enter__(self):
        self.local=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);self.local.bind(('127.0.0.1',10899))
        self.remote=physical(socket.SOCK_DGRAM);self.remote.settimeout(None);self.stop=False;self.client=None
        self.sent=0;self.received=0
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start();return self
    def run(self):
        while not self.stop:
            try:
                readable,_,_=select.select([self.local,self.remote],[],[],.2)
                for source in readable:
                    if source is self.local:
                        data,self.client=self.local.recvfrom(65536);self.remote.send(data);self.sent+=1
                    elif self.client:self.local.sendto(self.remote.recv(65536),self.client);self.received+=1
            except OSError:return
    def __exit__(self,*args):
        self.stop=True;self.thread.join(timeout=1);self.local.close();self.remote.close()


def xray_test(profile,directory,negative=False):
    config=copy.deepcopy(profile['clientConfig']);config['inbounds'][0]['port']=10897
    outbound=config['outbounds'][0]
    if outbound['protocol']=='trojan':server=outbound['settings']['servers'][0]
    else:server=outbound['settings']['vnext'][0]
    server['address']='127.0.0.1';server['port']=10898
    if 'xhttpSettings' in outbound['streamSettings']:outbound['streamSettings']['xhttpSettings']['host']=HOST
    file=Path(directory)/'client.json';file.write_text(json.dumps(config),encoding='utf-8')
    process=subprocess.Popen([str(XRAY),'run','-config',str(file)],stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        for attempt in range(40):
            if process.poll() is not None:raise RuntimeError('Generated Xray configuration rejected')
            try:
                with socket.create_connection(('127.0.0.1',10897),timeout=.1):break
            except OSError:time.sleep(.1)
        result=subprocess.run(['curl.exe','--silent','--show-error','--fail','--max-time','5' if negative else '25',
            '--proxy','socks5h://127.0.0.1:10897','https://api.ipify.org'],capture_output=True,timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW)
        success=result.returncode==0 and result.stdout.strip()==PRIMARY.encode()
        if success==negative:raise RuntimeError('Unexpected VPN connection result for '+profile['protocol'])
        if not negative:
            script=(ROOT/'server-operations/test-udp.cjs').read_text(encoding='utf-8').replace('port:10889','port:10897')
            udp=subprocess.run(['node','-e',script],capture_output=True,timeout=20,creationflags=subprocess.CREATE_NO_WINDOW)
            if udp.returncode:raise RuntimeError('UDP DNS failed for '+profile['protocol'])
    finally:
        process.terminate()
        try:process.wait(timeout=4)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=4)
        file.unlink(missing_ok=True)


def awg_test(profile):
    sections={};section=''
    for line in profile['configText'].splitlines():
        line=line.strip()
        if line.startswith('['):section=line;continue
        if '=' in line:sections[(section,line.split('=',1)[0].strip())]=line.split('=',1)[1].strip()
    def value(section,key):return sections[(section,key)]
    def key(value):return base64.b64decode(value).hex()
    lines=['private_key='+key(value('[Interface]','PrivateKey'))]
    mapping={'Jc':'jc','Jmin':'jmin','Jmax':'jmax','S1':'s1','S2':'s2','S3':'s3','S4':'s4','H1':'h1','H2':'h2','H3':'h3','H4':'h4',
        'HeaderProtectionKey':'header_protection_key','ContentPaddingAddition':'content_padding_addition','RekeyAfterTime':'rekey_after_time',
        'RekeyTimeout':'rekey_timeout','RejectAfterTime':'reject_after_time','KeepaliveTimeout':'keepalive_timeout','MaxHandshakeAttempts':'max_handshake_attempts'}
    for name,field in mapping.items():
        setting=value('[Interface]',name)
        lines.append(field+'='+(key(setting) if name=='HeaderProtectionKey' else setting))
    lines+=['public_key='+key(value('[Peer]','PublicKey')),'preshared_key='+key(value('[Peer]','PresharedKey')),
        'endpoint=127.0.0.1:10899','allowed_ip=0.0.0.0/0','persistent_keepalive_interval=25','']
    result=subprocess.run([str(PROBE)],input=json.dumps({'address':value('[Interface]','Address').split('/')[0],'uapi':'\n'.join(lines)}).encode(),
        capture_output=True,timeout=40,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode or not json.loads(result.stdout).get('awg31EncryptedConnection'):
        raise RuntimeError('AmneziaWG3.1 real encrypted request failed: '+result.stdout.decode(errors='replace')[:150])


def expect404(url):
    try:fetch(urllib.parse.urlsplit(url).path,authenticated=False)
    except urllib.error.HTTPError as error:
        if error.code==404:return
    raise RuntimeError('Revoked/out-of-scope bundle remained accessible')


def main():
    global csrf
    with socket.socket() as guard:guard.bind(('127.0.0.1',10897))
    if '--native-only' in sys.argv:
        report.update(json.loads((Path(__file__).parent/'verification-advanced.json').read_text(encoding='utf-8')))
    password=next(line.removeprefix('Пароль: ') for line in (PRIVATE/'VPN-Сайт-Доступ.txt').read_text(encoding='utf-8-sig').splitlines() if line.startswith('Пароль: '))
    login=api('login','POST',{'username':'admin','password':password});csrf=login['csrf']
    baseline={item['id'] for item in api('profiles')['profiles'] if item['active']}
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
    with Server(('127.0.0.1',10898),TCPHandler) as bridge,UDPBridge() as udp_bridge,tempfile.TemporaryDirectory(dir=PRIVATE,prefix='advanced-qa-') as directory:
        thread=threading.Thread(target=bridge.serve_forever,daemon=True);thread.start()
        try:
            for protocol in (('amneziawg','vless-reality') if '--native-only' in sys.argv else ('vless','trojan','vmess','vless-reality','amneziawg')):
                profile=api('profiles','POST',{'name':'QA-protocols-'+stamp+'-'+protocol,'device':'android','protocol':protocol})['profile']
                created.append(profile)
                if protocol=='amneziawg':
                    try:awg_test(profile)
                    except RuntimeError:
                        report['amneziawg']=False
                        print(json.dumps({'nativeDiagnostic':True,'udpSent':udp_bridge.sent,'udpReceived':udp_bridge.received}),flush=True)
                        time.sleep(30)
                        raise
                else:xray_test(profile,directory)
                report[protocol]=True
                if protocol=='amneziawg':report['awgTestNetworkPath']='existing-system-vpn' if '--system-udp' in sys.argv else 'physical-wifi'
                print(json.dumps({'verifiedProtocol':protocol,'exitIp':PRIMARY}),flush=True)
            pool=api('pools','POST',{'name':'QA-protocols-'+stamp,'profileIds':[profile['id'] for profile in created]})['pool'];pools.append(pool)
            assert pool['hasNativeProfiles'] and '/manage/pool/' in pool['qrUrl']
            bundle_path=urllib.parse.urlsplit(pool['qrUrl']).path
            page=fetch(bundle_path,authenticated=False);assert b'PrivateKey =' not in page
            data=fetch(bundle_path+'/bundle.zip',authenticated=False)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:assert len(archive.namelist())==2*sum(profile['protocol']!='amneziawg' for profile in created)+1
            expect404(pool['qrUrl']+'/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.conf')
            subscription=base64.b64decode(fetch(urllib.parse.urlsplit(pool['subscriptionUrl']).path,authenticated=False)).decode().splitlines()
            assert len(subscription)==len(created)-1 and all(link.startswith(('vless://','trojan://','vmess://')) for link in subscription)
            rotated=api('pools/'+pool['id']+'/rotate','POST',{})['pool'];expect404(pool['qrUrl'])
            report['mixedBundleZipAndScopedDownloads']=True
            report['mixedProxySubscriptionAndTokenRotation']=True
            reality=next(profile for profile in created if profile['protocol']=='vless-reality')
            api('profiles/'+reality['id'],'DELETE',{});xray_test(reality,directory,True)
            report['realityRevocationVerified']=True
        finally:
            for pool in pools:
                try:api('pools/'+pool['id'],'DELETE',{})
                except Exception:report['cleanupNeedsReview']=True
            for profile in created:
                try:api('profiles/'+profile['id'],'DELETE',{})
                except Exception:report['cleanupNeedsReview']=True
            remaining={item['id'] for item in api('profiles')['profiles'] if item['active']}
            report['originalProfilesPreserved']=remaining==baseline
            report['temporaryAccessRevoked']=not report.get('cleanupNeedsReview') and remaining==baseline
            report['osRoutesChanged']=False
            (PRIVATE/'advanced-test-state.json').write_text(json.dumps({'profileIds':[profile['id'] for profile in created],'poolIds':[pool['id'] for pool in pools]}),encoding='utf-8')
            (Path(__file__).parent/'verification-advanced.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
            bridge.shutdown();thread.join(timeout=2)
            api('logout','POST',{})
            print(json.dumps(report),flush=True)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'verificationFailed':type(error).__name__,'reason':str(error)[:200]}),flush=True)
        raise SystemExit(1)
