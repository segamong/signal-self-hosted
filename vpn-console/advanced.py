"""Fixed REALITY and AmneziaWG 3.1 helpers; credentials never enter command arguments."""
import base64
import json
from pathlib import Path
import socket
import subprocess
import urllib.parse

META = Path('/etc/signal-awg/metadata.json')
REALITY = Path('/etc/signal-vpn/reality-public.json')
AWG_SOCKET = Path('/var/run/amneziawg/awg-signal.sock')
AWG_BIN = '/opt/signal-awg/awg'
PRIMARY = '177.3.212.182'


def kind(inbound):
    return 'vless-reality' if inbound.get('streamSettings',{}).get('security') == 'reality' else inbound['protocol']


def uapi(lines=None):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(AWG_SOCKET))
        connection.sendall((('get=1\n\n') if lines is None else ('set=1\n'+'\n'.join(lines)+'\n\n')).encode())
        output = bytearray()
        while not output.endswith(b'\n\n'):
            data = connection.recv(65536)
            if not data or len(output)+len(data)>1024*1024:
                raise RuntimeError('Неверный ответ службы AmneziaWG.')
            output.extend(data)
    result = output.decode().splitlines()
    if 'errno=0' not in result:
        raise RuntimeError('Служба AmneziaWG не применила настройку.')
    return result


def awg_active():
    if not META.is_file():
        return set()
    try:
        return {('amneziawg',base64.b64encode(bytes.fromhex(line.split('=',1)[1])).decode())
                for line in uapi() if line.startswith('public_key=')}
    except (OSError,ValueError,RuntimeError):
        return set()


def available():
    if not META.is_file():
        return False
    try:
        uapi()
        return True
    except (OSError,RuntimeError):
        return False


def tool(argument, input=None):
    result = subprocess.run([AWG_BIN,argument],input=input,capture_output=True,timeout=5)
    if result.returncode:
        raise RuntimeError('Не удалось создать ключ AmneziaWG.')
    key = result.stdout.decode().strip()
    if len(base64.b64decode(key,validate=True)) != 32:
        raise RuntimeError('Некорректный ключ AmneziaWG.')
    return key


def restore_awg(extra):
    uapi(['public_key='+base64.b64decode(extra['publicKey']).hex(),
        'preshared_key='+base64.b64decode(extra['presharedKey']).hex(),
        'replace_allowed_ips=true','allowed_ip='+extra['address']+'/32',
        'allowed_ip='+extra['ipv6']+'/128'])


def remove_awg(extra):
    uapi(['public_key='+base64.b64decode(extra['publicKey']).hex(),'remove=true'])


def create_awg(used):
    if not available():
        raise ValueError('AmneziaWG 3.1 ещё не готов на сервере.')
    private = tool('genkey')
    public = tool('pubkey',(private+'\n').encode())
    number = next((number for number in range(2,255) if '10.89.0.'+str(number) not in used),None)
    if number is None:
        raise ValueError('Нет свободных адресов AmneziaWG.')
    extra = {'privateKey':private,'publicKey':public,'presharedKey':tool('genpsk'),
        'address':'10.89.0.'+str(number),'ipv6':'fd89:7369:676e::'+format(number,'x')}
    restore_awg(extra)
    return public,extra


def export_awg(row, profile):
    meta = json.loads(META.read_text())
    extra = json.loads(row['extra'])
    lines = ['[Interface]','PrivateKey = '+extra['privateKey'],
        'Address = '+extra['address']+'/32, '+extra['ipv6']+'/128',
        'DNS = 1.1.1.1, 1.0.0.1','MTU = 1280']
    lines += [key+' = '+str(value) for key,value in meta['obfuscation'].items()]
    lines += ['','[Peer]','PublicKey = '+meta['publicKey'],'PresharedKey = '+extra['presharedKey'],
        'Endpoint = '+PRIMARY+':443','AllowedIPs = 0.0.0.0/0, ::/0','PersistentKeepalive = 25','']
    text = '\n'.join(lines)
    profile.update({'uri':None,'clientConfig':None,'configText':text,'qrValue':text,
        'downloadFormat':'conf','security':'AmneziaWG 3.1 · ChaCha20-Poly1305',
        'clientHint':'Для этого .conf используйте AmneziaWG с поддержкой 3.1. Совместимость V2RayTun с полями 3.1 зависит от версии.'})
    return profile


def export_reality(row,config,profile):
    meta = json.loads(REALITY.read_text())
    sni = meta['serverName']
    short_id = meta['shortId']
    query = urllib.parse.urlencode({'encryption':'none','security':'reality','type':'tcp',
        'flow':'xtls-rprx-vision','sni':sni,'fp':row['fingerprint'],'pbk':meta['publicKey'],
        'sid':short_id,'spx':'/'})
    uri = 'vless://'+row['client_id']+'@'+PRIMARY+':443?'+query+'#'+urllib.parse.quote(row['name'])
    profile.update({'uri':uri,'qrValue':uri,'security':'REALITY · XTLS Vision',
        'clientConfig':{'log':{'access':'none','loglevel':'error'},'dns':{'queryStrategy':'UseIPv4','servers':['1.1.1.1']},
            'inbounds':[{'listen':'127.0.0.1','port':10889,'protocol':'socks','settings':{'auth':'noauth','udp':True}}],
            'outbounds':[{'protocol':'vless','settings':{'vnext':[{'address':PRIMARY,'port':443,
                'users':[{'id':row['client_id'],'encryption':'none','flow':'xtls-rprx-vision'}]}]},
                'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'serverName':sni,
                    'fingerprint':row['fingerprint'],'publicKey':meta['publicKey'],'shortId':short_id,'spiderX':'/'},
                    'sockopt':{'tcpKeepAliveIdle':30,'tcpKeepAliveInterval':15}}}]},
        'clientHint':'Для V2RayTun 5.26.83: импортировать ссылку целиком; профиль использует TCP 443 и XTLS Vision.'})
    return profile
