"""End-to-end console/VPN verification without printing access links or secrets."""
import base64
import copy
import datetime
import http.cookiejar
import json
import re
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / 'server-operations' / 'private'
BASE = 'https://vpn.signal-on.ru'
XRAY = ROOT / 'server-operations' / 'vendor' / 'xray-26.9.9' / 'xray.exe'
PORT = 10897
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = ''
profiles = []
pools = []
report = {}


def api(path, method='GET', body=None):
    headers = {'Accept': 'application/json'}
    if body is not None:
        headers.update({'Content-Type': 'application/json', 'Origin': BASE, 'X-CSRF-Token': csrf})
    query = urllib.request.Request(BASE + '/manage/api/' + path, method=method, headers=headers,
        data=json.dumps(body).encode() if body is not None else None)
    for attempt in range(3):
        try:
            with opener.open(query, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError:
            if method not in ('GET', 'DELETE') or attempt == 2:
                raise
            time.sleep(.4)


def subscription(url, absent=False):
    parsed = urllib.parse.urlsplit(url)
    assert parsed.scheme == 'https' and parsed.hostname == 'vpn.signal-on.ru' and parsed.path.startswith('/manage/sub/')
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                assert not absent, 'A revoked subscription still responds'
                assert 'no-store' in response.headers.get('Cache-Control', '')
                assert response.headers.get('Referrer-Policy') == 'no-referrer'
                return base64.b64decode(response.read(), validate=True).decode().splitlines()
        except urllib.error.HTTPError as error:
            assert absent and error.code == 404, 'Unexpected subscription status'
            return
        except urllib.error.URLError:
            if attempt == 2:
                raise
            time.sleep(.4)


def connect_profile(profile, directory, fingerprint):
    config = copy.deepcopy(profile['clientConfig'])
    config['log']['loglevel'] = 'debug'
    config['inbounds'][0]['port'] = PORT
    stream = config['outbounds'][0]['streamSettings']
    stream['tlsSettings']['fingerprint'] = fingerprint
    assert stream['tlsSettings']['minVersion'] == '1.3'
    assert not stream['tlsSettings']['allowInsecure']
    file = Path(directory) / 'client.json'
    file.write_text(json.dumps(config), encoding='utf-8')
    log_file = Path(directory) / 'client.log'
    log_output = log_file.open('wb')
    process = subprocess.Popen([str(XRAY), 'run', '-config', str(file)],
        stdout=log_output, stderr=log_output,
        creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        for _ in range(40):
            if process.poll() is not None:
                raise RuntimeError('Xray rejected a generated configuration')
            try:
                with socket.create_connection(('127.0.0.1', PORT), timeout=.2):
                    break
            except OSError:
                time.sleep(.1)
        result = subprocess.run(['curl.exe', '--silent', '--show-error', '--fail', '--max-time', '25',
            '--proxy', 'socks5h://127.0.0.1:' + str(PORT), 'https://api.ipify.org'],
            capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode != 0 or result.stdout.strip() != b'177.3.212.182':
            logs = log_file.read_text(encoding='utf-8', errors='replace')
            for sensitive in (profile['id'], stream['xhttpSettings']['path'],
                config['outbounds'][0]['settings']['vnext'][0]['users'][0]['id']):
                logs = logs.replace(sensitive, '<redacted>')
            logs = re.sub(r'https?://[^\s]+', '<url>', logs)
            print(json.dumps({'failedMode': profile['configuration'], 'curlCode': result.returncode,
                'curlError': result.stderr.decode(errors='replace')[:300], 'diagnostic': logs[-4500:]}), flush=True)
            raise RuntimeError('VPN connection failed: ' + profile['configuration'] + '/' + fingerprint)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        file.unlink(missing_ok=True)
        log_output.close()
        log_file.unlink(missing_ok=True)


def main():
    global csrf
    with socket.socket() as guard:
        guard.bind(('127.0.0.1', PORT))
    password = next(line.removeprefix('Пароль: ') for line in
        (PRIVATE / 'VPN-Сайт-Доступ.txt').read_text(encoding='utf-8-sig').splitlines() if line.startswith('Пароль: '))
    signed = api('login', 'POST', {'username': 'admin', 'password': password})
    assert signed['authenticated'] is True
    csrf = signed['csrf']
    baseline = {profile['id'] for profile in api('profiles')['profiles'] if profile['active']}
    pool_baseline = {pool['id'] for pool in api('pools')['pools'] if pool['active']}
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
    try:
        for mode in ('packet-up', 'auto', 'stream-up'):
            profile = api('profiles', 'POST', {'name': 'QA-pools-' + stamp + '-' + mode,
                'device': 'windows', 'configuration': mode, 'fingerprint': 'firefox' if mode == 'stream-up' else 'chrome'})['profile']
            profiles.append(profile)
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(profile['uri']).query)
            assert query['mode'] == [mode] and query['security'] == ['tls']
            assert query['fp'] == [profile['fingerprint']]
        report['profileOptionsPersisted'] = True
        failures = []
        if '--subscriptions-only' in sys.argv:
            previous = json.loads((Path(__file__).parent / 'verification-pools.json').read_text())
            assert previous.get('allThreeModesAndTwoFingerprintsConnected') is True
        else:
            with tempfile.TemporaryDirectory(prefix='pool-vpn-qa-', dir=PRIVATE) as directory:
                for profile in profiles:
                    for fingerprint in ('chrome', 'firefox'):
                        try:
                            connect_profile(profile, directory, fingerprint)
                            print(json.dumps({'vpnModeVerified': profile['configuration'], 'tlsFingerprint': fingerprint,
                                'exitIp': '177.3.212.182'}), flush=True)
                        except RuntimeError:
                            failures.append(profile['configuration'] + '/' + fingerprint)
        report['allThreeModesAndTwoFingerprintsConnected'] = not failures
        pool = api('pools', 'POST', {'name': 'QA-pools-' + stamp, 'profileIds': [profiles[0]['id'], profiles[2]['id']]})['pool']
        pools.append(pool)
        assert subscription(pool['subscriptionUrl']) == [profiles[0]['uri'], profiles[2]['uri']]
        report['subscriptionOnlyContainsSelectedProfiles'] = True
        rotated = api('pools/' + pool['id'] + '/rotate', 'POST', {})['pool']
        subscription(pool['subscriptionUrl'], absent=True)
        assert subscription(rotated['subscriptionUrl']) == [profiles[0]['uri'], profiles[2]['uri']]
        report['oldSubscriptionInvalidAfterRotation'] = True
        api('profiles/' + profiles[0]['id'], 'DELETE', {})
        assert subscription(rotated['subscriptionUrl']) == [profiles[2]['uri']]
        report['revokedProfilesExcludedFromSubscription'] = True
        api('pools/' + pool['id'], 'DELETE', {})
        subscription(rotated['subscriptionUrl'], absent=True)
        active = {profile['id'] for profile in api('profiles')['profiles'] if profile['active']}
        assert profiles[1]['id'] in active and profiles[2]['id'] in active
        report['poolRevocationDoesNotRevokeProfiles'] = True
        assert not failures, 'VPN modes failed: ' + ', '.join(failures)
    finally:
        cleanup_ok = True
        for pool in pools:
            try:
                api('pools/' + pool['id'], 'DELETE', {})
            except Exception:
                cleanup_ok = False
        for profile in profiles:
            try:
                api('profiles/' + profile['id'], 'DELETE', {})
            except Exception:
                cleanup_ok = False
        active = {profile['id'] for profile in api('profiles')['profiles'] if profile['active']}
        active_pools = {pool['id'] for pool in api('pools')['pools'] if pool['active']}
        report['originalProfilesAndPoolsPreserved'] = active == baseline and active_pools == pool_baseline
        report['temporaryAccessRevoked'] = cleanup_ok
        (PRIVATE / 'pool-test-state.json').write_text(json.dumps({'profileIds': [p['id'] for p in profiles],
            'poolIds': [p['id'] for p in pools]}), encoding='utf-8')
        api('logout', 'POST', {})
        (Path(__file__).parent / 'verification-pools.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)
        assert cleanup_ok and report['originalProfilesAndPoolsPreserved']


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'verificationFailed': type(error).__name__, 'reason': str(error)}), flush=True)
        raise SystemExit(1)
