"""Exercise the published console; never print cookies, passwords or VPN links."""
import http.cookiejar
import json
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / 'server-operations' / 'private'
BASE = 'https://vpn.signal-on.ru'
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = ''

def request(path, method='GET', body=None, authenticated=True):
    headers = {'Accept':'application/json'}
    if body is not None:
        headers.update({'Content-Type':'application/json','Origin':BASE})
        if csrf:
            headers['X-CSRF-Token'] = csrf
    query = urllib.request.Request(BASE + '/manage/api/' + path,
        data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    with opener.open(query, timeout=60) as response:
        return json.load(response)

def login():
    global csrf
    lines = (PRIVATE / 'VPN-Сайт-Доступ.txt').read_text(encoding='utf-8').splitlines()
    password = next(line.removeprefix('Пароль: ') for line in lines if line.startswith('Пароль: '))
    result = request('login', 'POST', {'username':'admin','password':password})
    assert result['authenticated'] is True
    csrf = result['csrf']

if __name__ == '__main__':
    import sys
    action = sys.argv[1] if len(sys.argv) > 1 else 'create'
    if action == 'create':
        try:
            request('profiles')
            raise RuntimeError('Private profiles unexpectedly public')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        login()
        status = request('status')
        assert status['online'] and status['exitIp'] == '177.3.212.182'
        before = request('profiles')['profiles']
        result = request('profiles', 'POST', {'name':'Проверка сайта QA','device':'windows'})
        profile = result['profile']
        assert 'security=tls' in profile['uri']
        assert profile['clientConfig']['outbounds'][0]['streamSettings']['tlsSettings']['minVersion'] == '1.3'
        assert request('profiles/' + profile['id'])['profile']['uri'] == profile['uri']
        (PRIVATE / 'portal-test-client.json').write_text(json.dumps(profile['clientConfig'], indent=2) + '\n')
        (PRIVATE / 'portal-test-state.json').write_text(json.dumps({'id':profile['id'],'profiles_before':len(before)}))
        request('logout', 'POST', {})
        print(json.dumps({'published_console_login':True,'private_profiles_protected':True,
                          'created_profile_with_tls13':True,'profiles_before':len(before)}))
    elif action == 'cleanup':
        state = json.loads((PRIVATE / 'portal-test-state.json').read_text())
        login()
        request('profiles/' + state['id'], 'DELETE', {})
        listed = request('profiles')['profiles']
        assert sum(row['active'] for row in listed) == state['profiles_before']
        assert next(row for row in listed if row['id'] == state['id'])['active'] is False
        request('logout', 'POST', {})
        print(json.dumps({'test_profile_revoked':True,'original_active_profiles_preserved':True}))
    else:
        raise SystemExit('Expected create or cleanup')
