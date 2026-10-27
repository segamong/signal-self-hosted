"""Create owner-only local login material; only its password hash goes to the VPS."""
import base64
import hashlib
import json
from pathlib import Path
import secrets

folder = Path(__file__).resolve().parent.parent / 'server-operations' / 'private'
auth_path = folder / 'vpn-portal-auth.json'
login_path = folder / 'VPN-Сайт-Доступ.txt'
if auth_path.exists() or login_path.exists():
    raise SystemExit('Access already prepared; refusing to replace the password.')
password = secrets.token_urlsafe(24)
salt = secrets.token_bytes(24)
digest = hashlib.scrypt(password.encode(), salt=salt, n=32768, r=8, p=1, dklen=32, maxmem=64*1024*1024)
auth = {'username':'admin','salt':base64.b64encode(salt).decode(),
        'passwordHash':base64.b64encode(digest).decode(),'n':32768,'r':8,'p':1}
auth_path.write_text(json.dumps(auth, indent=2) + '\n', encoding='utf-8')
login_path.write_text('Сайт: https://vpn.signal-on.ru/manage/\nЛогин: admin\nПароль: ' + password + '\n', encoding='utf-8')
print('Owner login prepared; password was not printed.')
