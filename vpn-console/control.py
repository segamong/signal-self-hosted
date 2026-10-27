#!/usr/bin/env python3
"""Narrow local provisioner. Its Unix socket accepts no paths or shell commands."""
import base64
from contextlib import contextmanager
import datetime as dt
import json
import importlib.util
import os
from pathlib import Path
import re
import secrets
import shutil
import socketserver
import sqlite3
import subprocess
import tempfile
import threading
import urllib.parse
import uuid
_advanced_spec = importlib.util.spec_from_file_location('signal_advanced',Path(__file__).with_name('advanced.py'))
advanced = importlib.util.module_from_spec(_advanced_spec)
_advanced_spec.loader.exec_module(advanced)

CONFIG = Path(os.environ.get('VPN_CONFIG', '/etc/signal-vpn/server.json'))
STATE = Path(os.environ.get('VPN_CONTROL_STATE', '/var/lib/signal-vpn-control'))
SOCKET = Path(os.environ.get('VPN_CONTROL_SOCKET', '/run/signal-vpn-control/control.sock'))
HOST = 'vpn.signal-on.ru'
PRIMARY = '177.3.212.182'
LOCK = threading.RLock()
CONFIGURATIONS = ('auto', 'packet-up', 'stream-up')
FINGERPRINTS = ('chrome', 'firefox')
PROTOCOLS = ('vless', 'trojan', 'vmess', 'vless-reality', 'amneziawg')
PORTS = {'vless': 39443, 'trojan': 39444, 'vmess': 39445, 'vless-reality':39446}
IDENTIFIER = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
SUBSCRIPTION_TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

class Controller:
    def __init__(self, config=CONFIG, state=STATE, apply=None):
        self.config = Path(config)
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state.chmod(0o700)
        self.db = self.state / 'profiles.sqlite'
        self.apply = apply or self.apply_config
        with self.connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,device TEXT NOT NULL,client_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT)')
            columns = {row['name'] for row in db.execute('PRAGMA table_info(profiles)')}
            if 'configuration' not in columns:
                db.execute("ALTER TABLE profiles ADD COLUMN configuration TEXT NOT NULL DEFAULT 'packet-up'")
            if 'fingerprint' not in columns:
                db.execute("ALTER TABLE profiles ADD COLUMN fingerprint TEXT NOT NULL DEFAULT 'chrome'")
            if 'protocol' not in columns:
                db.execute("ALTER TABLE profiles ADD COLUMN protocol TEXT NOT NULL DEFAULT 'vless'")
            if 'extra' not in columns:
                db.execute("ALTER TABLE profiles ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'")
            db.execute('CREATE TABLE IF NOT EXISTS pools(id TEXT PRIMARY KEY,name TEXT NOT NULL,token TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS pool_profiles(pool_id TEXT NOT NULL,profile_id TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(pool_id,profile_id),FOREIGN KEY(pool_id) REFERENCES pools(id),FOREIGN KEY(profile_id) REFERENCES profiles(id))')
        self.db.chmod(0o600)
        self.import_existing()

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.db, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def read_config(self):
        config = json.loads(self.config.read_text())
        inbounds = config.get('inbounds', [])
        if not inbounds or config['outbounds'][0]['sendThrough'] != PRIMARY:
            raise RuntimeError('Настройка VPN не соответствует ожидаемой схеме. Изменения не применены.')
        protocols = set()
        paths = set()
        for inbound in inbounds:
            protocol = advanced.kind(inbound)
            stream = inbound.get('streamSettings', {})
            path = stream.get('xhttpSettings', {}).get('path', '')
            valid_transport = (stream.get('network') == 'xhttp' and stream.get('security','none') == 'none'
                and isinstance(path,str) and re.fullmatch(r'/[a-f0-9]{48}',path) and path not in paths)
            if protocol == 'vless-reality':
                valid_transport = stream.get('network') in ('raw','tcp') and stream.get('security') == 'reality'
            if not (protocol in PORTS and protocol not in protocols
                    and inbound.get('listen') == '127.0.0.1' and inbound.get('port') == PORTS[protocol]
                    and valid_transport):
                raise RuntimeError('Настройка VPN не соответствует ожидаемой схеме. Изменения не применены.')
            protocols.add(protocol)
            paths.add(path)
        if 'vless' not in protocols:
            raise RuntimeError('Основной протокол VPN не найден.')
        return config

    @staticmethod
    def inbound(config, protocol):
        for inbound in config['inbounds']:
            if advanced.kind(inbound) == protocol:
                return inbound
        raise ValueError('Этот протокол ещё не настроен на сервере.')

    @staticmethod
    def active_credentials(config):
        return {(advanced.kind(inbound), client['password' if inbound['protocol'] == 'trojan' else 'id'])
                for inbound in config['inbounds'] for client in inbound['settings']['clients']}

    def import_existing(self):
        config = self.read_config()
        with self.connection() as db:
            for inbound in config['inbounds']:
                protocol = advanced.kind(inbound)
                for client in inbound['settings']['clients']:
                    credential = client['password' if protocol == 'trojan' else 'id']
                    existing = db.execute('SELECT protocol FROM profiles WHERE client_id=?', (credential,)).fetchone()
                    if existing:
                        if existing['protocol'] != protocol:
                            raise RuntimeError('Один идентификатор доступа используется разными протоколами. Проверьте настройку VPN.')
                        continue
                    email = client.get('email', '')
                    device = 'windows' if 'windows' in email else 'android' if 'android' in email else 'other'
                    name = {'windows':'Windows','android':'Android','other':'Существующий профиль'}[device]
                    db.execute('INSERT INTO profiles(id,name,device,client_id,created_at,revoked_at,protocol) VALUES(?,?,?,?,?,NULL,?)',
                               (str(uuid.uuid4()), name, device, credential, now(), protocol))

    def public(self, row, active_ids):
        return {'id': row['id'], 'name': row['name'], 'device': row['device'],
                'configuration': row['configuration'], 'fingerprint': row['fingerprint'], 'protocol': row['protocol'],
                'createdAt': row['created_at'], 'active': not row['revoked_at'] and (row['protocol'], row['client_id']) in active_ids}

    @staticmethod
    def valid_name(name):
        if not isinstance(name, str) or not (1 <= len(name.strip()) <= 48) or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError('Название должно содержать от 1 до 48 символов.')
        return name.strip()

    def export_profile(self, row, config, active_ids):
        protocol = row['protocol']
        if protocol == 'amneziawg':
            return advanced.export_awg(row,self.public(row,active_ids))
        if protocol == 'vless-reality':
            return advanced.export_reality(row,config,self.public(row,active_ids))
        path = self.inbound(config, protocol)['streamSettings']['xhttpSettings']['path']
        query = urllib.parse.urlencode({'encryption':'none','security':'tls','sni':HOST,
            'fp':row['fingerprint'],'alpn':'h2','type':'xhttp','mode':row['configuration'],'path':path})
        if protocol != 'vless':
            query = urllib.parse.urlencode({'security':'tls','sni':HOST,'fp':row['fingerprint'],
                'alpn':'h2','type':'xhttp','mode':row['configuration'],'path':path})
        # Standard VMess URI preserves XHTTP mode in both Windows and Android clients.
        uri = protocol + '://' + urllib.parse.quote(row['client_id'], safe='') + '@' + HOST + ':443?' + query + '#' + urllib.parse.quote(row['name'])
        if protocol == 'trojan':
            settings = {'servers':[{'address':HOST,'port':443,'password':row['client_id']}]}
        else:
            user = {'id':row['client_id'],'encryption':'none'} if protocol == 'vless' else {'id':row['client_id'],'alterId':0,'security':'auto'}
            settings = {'vnext':[{'address':HOST,'port':443,'users':[user]}]}
        client_config = {'log':{'access':'none','loglevel':'error'},
            'inbounds':[{'listen':'127.0.0.1','port':10889,'protocol':'socks','settings':{'auth':'noauth','udp':True}}],
            'outbounds':[{'protocol':protocol,'settings':settings,
                'streamSettings':{'network':'xhttp','security':'tls',
                    'tlsSettings':{'serverName':HOST,'allowInsecure':False,'fingerprint':row['fingerprint'],'alpn':['h2'],'minVersion':'1.3'},
                    'xhttpSettings':{'path':path,'mode':row['configuration'],'xPaddingBytes':'100-1000'}}}]}
        profile = self.public(row, active_ids)
        profile.update({'uri':uri,'clientConfig':client_config})
        return profile

    def public_pool(self, row, db, active_ids):
        profiles = db.execute('SELECT p.* FROM profiles p JOIN pool_profiles m ON m.profile_id=p.id WHERE m.pool_id=? ORDER BY m.position', (row['id'],)).fetchall()
        active = not bool(row['revoked_at'])
        base = 'https://' + HOST
        bundle_url = base+'/manage/pool/'+row['token'] if active else None
        has_native = any(profile['protocol']=='amneziawg' for profile in profiles)
        proxy_count = sum(not profile['revoked_at'] and profile['protocol']!='amneziawg' and
            (profile['protocol'],profile['client_id']) in active_ids for profile in profiles)
        subscription_url = base+'/manage/sub/'+row['token'] if active and proxy_count else None
        return {'id':row['id'],'name':row['name'],'createdAt':row['created_at'],
            'profileIds':[profile['id'] for profile in profiles], 'active':active,
            'activeProfilesCount':sum(not profile['revoked_at'] and (profile['protocol'], profile['client_id']) in active_ids for profile in profiles),
            'subscriptionUrl':subscription_url,'bundleUrl':bundle_url,'hasNativeProfiles':has_native,
            'qrUrl':bundle_url if has_native else subscription_url}

    def run_pool(self, request, db, config, active_ids):
        operation = request.get('op')
        if operation == 'pool-list':
            rows = db.execute('SELECT * FROM pools WHERE revoked_at IS NULL OR id IN (SELECT id FROM pools WHERE revoked_at IS NOT NULL ORDER BY created_at DESC LIMIT 20) ORDER BY created_at DESC').fetchall()
            return {'ok':True,'pools':[self.public_pool(row, db, active_ids) for row in rows]}
        if operation in ('subscription','bundle','bundle-profile'):
            token = request.get('token')
            if not isinstance(token, str) or not SUBSCRIPTION_TOKEN.fullmatch(token):
                return {'ok':True,operation:None}
            row = db.execute('SELECT * FROM pools WHERE token=? AND revoked_at IS NULL', (token,)).fetchone()
            if not row:
                return {'ok':True,operation:None}
            profiles = db.execute('SELECT p.* FROM profiles p JOIN pool_profiles m ON m.profile_id=p.id WHERE m.pool_id=? AND p.revoked_at IS NULL ORDER BY m.position', (row['id'],)).fetchall()
            profiles = [profile for profile in profiles if (profile['protocol'],profile['client_id']) in active_ids]
            if operation == 'bundle':
                return {'ok':True,'bundle':{'name':row['name'],'profiles':[self.public(profile,active_ids) for profile in profiles],
                    'subscriptionUrl':'https://'+HOST+'/manage/sub/'+token} if profiles else None}
            if operation == 'bundle-profile':
                selected = next((profile for profile in profiles if profile['id']==request.get('id')),None)
                return {'ok':True,'bundle-profile':self.export_profile(selected,config,active_ids) if selected else None}
            uris = [self.export_profile(profile, config, active_ids)['uri'] for profile in profiles if profile['protocol']!='amneziawg']
            if not uris:
                return {'ok':True,'subscription':None}
            encoded = base64.b64encode(('\n'.join(uris) + '\n').encode()).decode('ascii')
            return {'ok':True,'subscription':encoded}
        if operation == 'pool-create':
            name = self.valid_name(request.get('name'))
            ids = request.get('profileIds')
            if not isinstance(ids, list) or not 1 <= len(ids) <= 50 or any(not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier) for identifier in ids) or len(set(ids)) != len(ids):
                raise ValueError('Выберите от 1 до 50 разных активных профилей.')
            if db.execute('SELECT COUNT(*) FROM pools WHERE revoked_at IS NULL').fetchone()[0] >= 20:
                raise ValueError('Достигнут предел: 20 активных пулов.')
            for identifier in ids:
                profile = db.execute('SELECT * FROM profiles WHERE id=? AND revoked_at IS NULL', (identifier,)).fetchone()
                if not profile or (profile['protocol'], profile['client_id']) not in active_ids:
                    raise ValueError('В пул можно добавить только активные профили.')
            identifier = str(uuid.uuid4())
            db.execute('INSERT INTO pools VALUES(?,?,?,?,NULL)', (identifier,name,secrets.token_urlsafe(32),now()))
            db.executemany('INSERT INTO pool_profiles VALUES(?,?,?)', [(identifier,profile_id,position) for position,profile_id in enumerate(ids)])
            row = db.execute('SELECT * FROM pools WHERE id=?', (identifier,)).fetchone()
            return {'ok':True,'pool':self.public_pool(row, db, active_ids)}
        identifier = request.get('id')
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise ValueError('Пул не найден.')
        row = db.execute('SELECT * FROM pools WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise ValueError('Пул не найден.')
        if operation == 'pool-revoke':
            db.execute('UPDATE pools SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', (now(),identifier))
            return {'ok':True}
        if operation == 'pool-rotate':
            if row['revoked_at']:
                raise ValueError('Этот пул отключён. Создайте новый.')
            db.execute('UPDATE pools SET token=? WHERE id=?', (secrets.token_urlsafe(32),identifier))
            row = db.execute('SELECT * FROM pools WHERE id=?', (identifier,)).fetchone()
        return {'ok':True,'pool':self.public_pool(row, db, active_ids)}

    def apply_config(self, candidate):
        original = self.config.read_bytes()
        info = self.config.stat()
        history = self.state / 'config-backups'
        history.mkdir(mode=0o700, exist_ok=True)
        history.chmod(0o700)
        backup = history / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(4) + '.json')
        backup.write_bytes(original)
        backup.chmod(0o600)
        fd, temporary = tempfile.mkstemp(prefix='.portal-', suffix='.json', dir=self.config.parent)
        try:
            with os.fdopen(fd, 'w') as output:
                json.dump(candidate, output, indent=2)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
            os.chown(temporary, info.st_uid, info.st_gid)
            os.chmod(temporary, info.st_mode & 0o777)
            result = subprocess.run(['/opt/signal-vpn/xray',
                                     'run', '-test', '-config', temporary], capture_output=True, timeout=15)
            if result.returncode:
                print('VPN_VALIDATE_FAILED: checked configuration was rejected', flush=True)
                raise RuntimeError('Конфигурация не прошла проверку. Изменения не применены.')
            os.replace(temporary, self.config)
            try:
                result = subprocess.run(['systemctl', 'restart', 'signal-vpn.service'], capture_output=True, timeout=20)
                healthy = subprocess.run(['systemctl', 'is-active', '--quiet', 'signal-vpn.service'], timeout=5).returncode == 0
                if result.returncode or not healthy:
                    raise RuntimeError('VPN restart failed')
            except Exception:
                restore_fd, restore_name = tempfile.mkstemp(prefix='.restore-', suffix='.json', dir=self.config.parent)
                with os.fdopen(restore_fd, 'wb') as output:
                    output.write(original)
                    output.flush()
                    os.fsync(output.fileno())
                os.chown(restore_name, info.st_uid, info.st_gid)
                os.chmod(restore_name, info.st_mode & 0o777)
                os.replace(restore_name, self.config)
                recovered = False
                try:
                    retry = subprocess.run(['systemctl', 'restart', 'signal-vpn.service'], capture_output=True, timeout=20)
                    recovered = retry.returncode == 0 and subprocess.run(
                        ['systemctl', 'is-active', '--quiet', 'signal-vpn.service'], timeout=5).returncode == 0
                except Exception:
                    pass
                message = 'Не удалось применить профиль. Предыдущая настройка восстановлена.'
                if not recovered:
                    message += ' Служба VPN требует проверки администратором.'
                raise RuntimeError(message) from None
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def run(self, request):
        with LOCK:
            config = self.read_config()
            active_ids = self.active_credentials(config) | advanced.awg_active()
            operation = request.get('op')
            if operation == 'status':
                online = subprocess.run(['systemctl', 'is-active', '--quiet', 'signal-vpn'], timeout=5).returncode == 0
                return {'ok': True, 'status': {'online': online, 'entryHost': HOST,
                    'entryIp': PRIMARY, 'exitIp': PRIMARY, 'transport': 'TLS 1.3 · XHTTP',
                    'profilesCount': len(active_ids), 'protocols': [advanced.kind(inbound) for inbound in config['inbounds']]+(['amneziawg'] if advanced.available() else [])}}
            with self.connection() as db:
                if operation in ('pool-list', 'pool-create', 'pool-get', 'pool-revoke', 'pool-rotate', 'subscription','bundle','bundle-profile'):
                    return self.run_pool(request, db, config, active_ids)
                if operation == 'list':
                    rows = db.execute('SELECT * FROM profiles WHERE revoked_at IS NULL OR id IN (SELECT id FROM profiles WHERE revoked_at IS NOT NULL ORDER BY created_at DESC LIMIT 100) ORDER BY created_at DESC').fetchall()
                    return {'ok': True, 'profiles': [self.public(row, active_ids) for row in rows]}
                if operation == 'create':
                    name = self.valid_name(request.get('name'))
                    device = request.get('device')
                    if device not in ('windows', 'android', 'other'):
                        raise ValueError('Выберите устройство.')
                    configuration = request.get('configuration', 'packet-up')
                    fingerprint = request.get('fingerprint', 'chrome')
                    protocol = request.get('protocol', 'vless')
                    if not isinstance(protocol, str) or protocol not in PROTOCOLS:
                        raise ValueError('Выберите поддерживаемый протокол.')
                    if protocol not in ('amneziawg','vless-reality') and configuration not in CONFIGURATIONS:
                        raise ValueError('Выберите режим Auto, Packet-up или Stream-up.')
                    if protocol != 'amneziawg' and fingerprint not in FINGERPRINTS:
                        raise ValueError('Выберите TLS-профиль Chrome или Firefox.')
                    if len(active_ids) >= 50:
                        raise ValueError('Достигнут предел: 50 активных профилей.')
                    rows = db.execute('SELECT * FROM profiles WHERE revoked_at IS NULL').fetchall()
                    if any(row['name'].casefold() == name.casefold() for row in rows):
                        raise ValueError('Профиль с таким названием уже существует.')
                    if protocol == 'amneziawg':
                        profile_id = str(uuid.uuid4())
                        used = {json.loads(row['extra'])['address'] for row in rows if row['protocol']=='amneziawg'}
                        db.execute('BEGIN IMMEDIATE')
                        credential,extra = advanced.create_awg(used)
                        try:
                            db.execute("INSERT INTO profiles(id,name,device,client_id,created_at,revoked_at,configuration,fingerprint,protocol,extra) VALUES(?,?,?,?,?,NULL,'udp','none','amneziawg',?)",
                                (profile_id,name,device,credential,now(),json.dumps(extra)))
                            db.commit()
                        except Exception:
                            advanced.remove_awg(extra)
                            raise
                        return self.run({'op':'get','id':profile_id})
                    clients = self.inbound(config, protocol)['settings']['clients']
                    if protocol == 'vless-reality':
                        configuration = 'tcp'
                    profile_id = str(uuid.uuid4())
                    client_id = secrets.token_urlsafe(32) if protocol == 'trojan' else str(uuid.uuid4())
                    created = now()
                    client = {'password' if protocol == 'trojan' else 'id': client_id, 'email': 'portal-' + profile_id}
                    if protocol == 'vmess':
                        client['alterId'] = 0
                    if protocol == 'vless-reality':
                        client['flow'] = 'xtls-rprx-vision'
                    clients.append(client)
                    # Commit metadata only after the checked VPN configuration is active.
                    db.execute('BEGIN IMMEDIATE')
                    db.execute('INSERT INTO profiles(id,name,device,client_id,created_at,revoked_at,configuration,fingerprint,protocol) VALUES(?,?,?,?,?,NULL,?,?,?)',
                               (profile_id, name, device, client_id, created, configuration, fingerprint, protocol))
                    previous = self.read_config()
                    self.apply(config)
                    try:
                        db.commit()
                    except Exception:
                        self.apply(previous)
                        raise
                    return self.run({'op':'get','id':profile_id})
                if operation not in ('get', 'revoke'):
                    raise ValueError('Неизвестная операция.')
                profile_id = request.get('id', '')
                if not isinstance(profile_id, str) or not IDENTIFIER.fullmatch(profile_id):
                    raise ValueError('Профиль не найден.')
                row = db.execute('SELECT * FROM profiles WHERE id=?', (profile_id,)).fetchone()
                if row is None:
                    raise ValueError('Профиль не найден.')
                if operation == 'revoke':
                    if row['protocol']=='amneziawg':
                        if not row['revoked_at']:
                            extra = json.loads(row['extra'])
                            db.execute('BEGIN IMMEDIATE')
                            advanced.remove_awg(extra)
                            try:
                                db.execute('UPDATE profiles SET revoked_at=? WHERE id=?',(now(),profile_id))
                                db.commit()
                            except Exception:
                                advanced.restore_awg(extra)
                                raise
                        return {'ok':True}
                    if not row['revoked_at'] and (row['protocol'], row['client_id']) in active_ids:
                        inbound = self.inbound(config, row['protocol'])
                        key = 'password' if row['protocol'] == 'trojan' else 'id'
                        inbound['settings']['clients'] = [client for client in inbound['settings']['clients'] if client[key] != row['client_id']]
                        db.execute('BEGIN IMMEDIATE')
                        db.execute('UPDATE profiles SET revoked_at=? WHERE id=?', (now(), profile_id))
                        previous = self.read_config()
                        self.apply(config)
                        try:
                            db.commit()
                        except Exception:
                            self.apply(previous)
                            raise
                    return {'ok': True}
                if row['revoked_at'] or (row['protocol'], row['client_id']) not in active_ids:
                    raise ValueError('Этот профиль отключён. Создайте новый.')
                return {'ok':True,'profile':self.export_profile(row, config, active_ids)}

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(40)
        try:
            line = self.rfile.readline(8193)
            if len(line) > 8192 or not line.endswith(b'\n'):
                raise ValueError('Слишком большой запрос.')
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('Неверный запрос.')
            response = self.server.controller.run(request)
        except (ValueError, RuntimeError) as error:
            response = {'ok':False,'error':str(error)}
        except Exception:
            response = {'ok':False,'error':'Не удалось выполнить операцию. Попробуйте ещё раз.'}
        self.wfile.write(json.dumps(response, ensure_ascii=False).encode() + b'\n')

def main():
    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    os.umask(0o077)
    controller = Controller()
    SOCKET.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    if SOCKET.exists():
        if not SOCKET.is_socket():
            raise RuntimeError('Unexpected control socket path')
        SOCKET.unlink()
    with Server(str(SOCKET), Handler) as server:
        server.controller = controller
        SOCKET.chmod(0o660)
        print('Signal VPN profile controller ready', flush=True)
        server.serve_forever()

if __name__ == '__main__':
    main()
