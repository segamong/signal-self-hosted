#!/usr/bin/env python3
"""Private VPN management gateway. Run behind the local HTTPS reverse proxy.

This process never edits VPN configuration or holds root privileges. Its small
JSON protocol delegates profile operations to the privileged Unix socket helper.
"""

from __future__ import annotations

import base64
import collections
from contextlib import contextmanager
import hashlib
import hmac
import html
import io
import http.cookies
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import threading
import time
import zipfile
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import unquote, urlsplit


SESSION_SECONDS = 8 * 60 * 60
MAX_BODY = 8192
MAX_HELPER_RESPONSE = 128 * 1024
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; "
    "form-action 'self'; base-uri 'none'; object-src 'none'"
)
PROFILE_ID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
SUBSCRIPTION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")


class APIError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class Config:
    web_root: Path
    auth_file: Path
    state_dir: Path
    control_socket: str
    public_origin: str = "https://vpn.signal-on.ru"
    port: int = 3180
    allow_http_local: bool = False

    def __post_init__(self):
        origin = urlsplit(self.public_origin)
        local_http = (
            self.allow_http_local
            and origin.scheme == "http"
            and origin.hostname in {"127.0.0.1", "localhost", "::1"}
        )
        if (
            (origin.scheme != "https" and not local_http)
            or not origin.netloc
            or origin.username is not None
            or origin.password is not None
            or origin.path
            or origin.query
            or origin.fragment
            or not 1 <= self.port <= 65535
        ):
            raise ValueError("VPN_PUBLIC_ORIGIN must be an HTTPS origin without a path")

    @property
    def secure_cookie(self) -> bool:
        return self.public_origin.startswith("https://")

    @property
    def cookie_name(self) -> str:
        return "__Secure-signalvpn" if self.secure_cookie else "signalvpn"

    @classmethod
    def from_environment(cls) -> "Config":
        return cls(
            web_root=Path(os.environ.get("VPN_WEB_ROOT", str(Path(__file__).parent / "web"))),
            auth_file=Path(os.environ.get("VPN_AUTH_FILE", "/etc/signal-vpn-web/auth.json")),
            state_dir=Path(os.environ.get("VPN_STATE_DIR", "/var/lib/signal-vpn-web")),
            control_socket=os.environ.get("VPN_CONTROL_SOCKET", "/run/signal-vpn-control/control.sock"),
            public_origin=os.environ.get("VPN_PUBLIC_ORIGIN", "https://vpn.signal-on.ru"),
            port=int(os.environ.get("VPN_WEB_PORT", "3180")),
            allow_http_local=os.environ.get("VPN_ALLOW_HTTP_LOCAL") == "1",
        )


class LoginLimiter:
    """Bounded, thread-safe attempt limits; successful logins are counted too."""

    def __init__(self):
        self.lock = threading.Lock()
        self.global_attempts = collections.deque()
        self.by_ip: dict[str, collections.deque] = {}

    def reserve(self, address: str) -> None:
        now = time.monotonic()
        cutoff = now - 900
        with self.lock:
            while self.global_attempts and self.global_attempts[0] <= cutoff:
                self.global_attempts.popleft()
            for key in list(self.by_ip):
                attempts = self.by_ip[key]
                while attempts and attempts[0] <= cutoff:
                    attempts.popleft()
                if not attempts:
                    del self.by_ip[key]
            attempts = self.by_ip.get(address)
            if len(self.global_attempts) >= 60 or (attempts is not None and len(attempts) >= 10):
                raise APIError(429, "Слишком много попыток входа. Повторите через 15 минут.")
            if attempts is None:
                # The global cap also limits the number of new keys in this window.
                attempts = self.by_ip[address] = collections.deque()
            attempts.append(now)
            self.global_attempts.append(now)


class Application:
    def __init__(self, config: Config, controller: Callable[[dict], dict] | None = None):
        self.config = config
        self.web_root = config.web_root.resolve()
        self.limiter = LoginLimiter()
        self.password_jobs = threading.BoundedSemaphore(2)
        self.controller = controller or self._socket_request
        config.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(config.state_dir, 0o700)
        self.database = config.state_dir / "sessions.sqlite3"
        with self.connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS sessions ("
                "token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, "
                "csrf TEXT NOT NULL, expires INTEGER NOT NULL)"
            )
            db.execute("DELETE FROM sessions WHERE expires <= ?", (int(time.time()),))
        os.chmod(self.database, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def password_matches(self, username: str, password: str) -> bool:
        if not self.password_jobs.acquire(timeout=2):
            raise APIError(429, "Слишком много попыток входа. Повторите позже.")
        try:
            with self.config.auth_file.open("rb") as handle:
                raw = handle.read(16385)
            if len(raw) > 16384:
                raise ValueError("oversized auth file")
            auth = json.loads(raw)
            if (auth["n"], auth["r"], auth["p"]) != (32768, 8, 1):
                raise ValueError("unsupported password parameters")
            salt = base64.b64decode(auth["salt"], validate=True)
            expected = base64.b64decode(auth["passwordHash"], validate=True)
            if not 16 <= len(salt) <= 64 or len(expected) != 32:
                raise ValueError("invalid password material")
            actual = hashlib.scrypt(
                password.encode("utf-8"), salt=salt, n=32768, r=8, p=1,
                dklen=32, maxmem=64 * 1024 * 1024,
            )
            password_ok = hmac.compare_digest(actual, expected)
            username_ok = hmac.compare_digest(username.encode("utf-8"), str(auth["username"]).encode("utf-8"))
            return password_ok and username_ok
        except (OSError, ValueError, TypeError, KeyError):
            raise APIError(503, "Вход временно недоступен. Проверьте настройки доступа.") from None
        finally:
            self.password_jobs.release()

    def create_session(self, username: str) -> tuple[str, str]:
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        now = int(time.time())
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            db.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?)",
                (hashlib.sha256(token.encode("ascii")).hexdigest(), username, csrf, now + SESSION_SECONDS),
            )
        return token, csrf

    def session(self, token: str | None):
        if not token or len(token) != 43 or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
            return None
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        with self.connect() as db:
            row = db.execute(
                "SELECT username, csrf FROM sessions WHERE token_hash = ? AND expires > ?",
                (token_hash, int(time.time())),
            ).fetchone()
        return dict(row) if row else None

    def logout(self, token: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode("ascii")).hexdigest(),))

    def helper(self, request: dict) -> dict:
        try:
            result = self.controller(request)
        except (OSError, ValueError, TypeError, TimeoutError):
            raise APIError(503, "Сервис VPN временно недоступен.") from None
        if not isinstance(result, dict) or result.get("ok") is not True:
            error = result.get("error") if isinstance(result, dict) else None
            if not isinstance(error, str) or not error.strip():
                error = "Не удалось выполнить операцию с VPN."
            raise APIError(502, error[:300])
        return result

    def _socket_request(self, request: dict) -> dict:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(60)
            client.connect(self.config.control_socket)
            client.sendall(json.dumps(request, ensure_ascii=False).encode("utf-8") + b"\n")
            data = bytearray()
            while b"\n" not in data:
                block = client.recv(min(16384, MAX_HELPER_RESPONSE + 1 - len(data)))
                if not block:
                    raise ValueError("incomplete helper response")
                data.extend(block)
                if len(data) > MAX_HELPER_RESPONSE:
                    raise ValueError("oversized helper response")
            line = bytes(data).split(b"\n", 1)[0]
            return json.loads(line.decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    server_version = "SignalVPN"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def setup(self):
        self.request.settimeout(15)
        super().setup()

    @property
    def app(self) -> Application:
        return self.server.app

    def log_message(self, _format, *args):
        # Requests can contain profile credentials; never log URLs, headers or bodies.
        pass

    def do_GET(self):
        self.dispatch()

    def do_HEAD(self):
        self.dispatch(head=True)

    def do_POST(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def do_PUT(self):
        self.respond(405, {"error": "Метод не поддерживается."})

    do_PATCH = do_PUT
    do_OPTIONS = do_PUT
    do_TRACE = do_PUT
    do_CONNECT = do_PUT

    def dispatch(self, head: bool = False):
        try:
            path = urlsplit(self.path).path
            if path == "/manage" and self.command in {"GET", "HEAD"}:
                self.respond(308, b"", {"Location": "/manage/"}, head=head)
            elif path.startswith("/manage/api/"):
                if head:
                    raise APIError(405, "Метод не поддерживается.")
                self.api(path)
            elif path.startswith("/manage/sub/"):
                self.subscription(path, head=head)
            elif path.startswith("/manage/pool/"):
                self.bundle(path, head=head)
            elif self.command in {"GET", "HEAD"}:
                self.static(path, head=head)
            else:
                raise APIError(404, "Страница не найдена.")
        except APIError as error:
            headers = {"Retry-After": "900"} if error.status == 429 else None
            self.respond(error.status, {"error": error.message}, headers, head=head)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            # Keep server configuration and profile material out of error responses.
            self.respond(500, {"error": "Внутренняя ошибка сервиса."}, head=head)

    def respond(self, status: int, payload, headers: dict | None = None, head: bool = False):
        headers = dict(headers or {})
        if isinstance(payload, dict):
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            content_type = "application/json; charset=utf-8"
        else:
            body = payload
            content_type = "application/octet-stream"
        self.send_response(status)
        self.send_header("Content-Type", headers.pop("Content-Type", content_type))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if self.app.config.secure_cookie:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        for key, value in headers.items():
            self.send_header(key, value)
        # One request per connection avoids unread invalid bodies becoming requests.
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if not head:
            self.wfile.write(body)

    def cookie_token(self) -> str | None:
        try:
            cookies = http.cookies.SimpleCookie()
            cookies.load(self.headers.get("Cookie", ""))
            value = cookies.get(self.app.config.cookie_name)
            return value.value if value else None
        except http.cookies.CookieError:
            return None

    def cookie(self, token: str, max_age: int = SESSION_SECONDS) -> str:
        value = f"{self.app.config.cookie_name}={token}; Path=/manage/; Max-Age={max_age}; HttpOnly; SameSite=Strict"
        if self.app.config.secure_cookie:
            value += "; Secure"
        return value

    def mutation_body(self) -> dict:
        if self.headers.get("Origin") != self.app.config.public_origin:
            raise APIError(403, "Недопустимый источник запроса.")
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "Неподдерживаемый формат запроса.")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise APIError(415, "Ожидается JSON.")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            raise APIError(411, "Не указан размер запроса.")
        try:
            length = int(lengths[0])
        except ValueError:
            raise APIError(400, "Неверный размер запроса.") from None
        if length < 0:
            raise APIError(400, "Неверный размер запроса.")
        if length > MAX_BODY:
            raise APIError(413, "Запрос слишком большой.")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, "Некорректный JSON.") from None
        if not isinstance(body, dict):
            raise APIError(400, "Ожидается объект JSON.")
        return body

    def client_ip(self) -> str:
        address = self.client_address[0]
        # This listener only binds loopback. Caddy appends the real peer address;
        # use the rightmost hop so a client-supplied first value is never trusted.
        forwarded = self.headers.get("X-Forwarded-For", "")
        try:
            if ipaddress.ip_address(address).is_loopback and len(forwarded) < 2048 and forwarded:
                address = str(ipaddress.ip_address(forwarded.rsplit(",", 1)[-1].strip()))
        except ValueError:
            pass
        return address

    def bundle(self,path: str,head: bool = False):
        if self.command not in {"GET","HEAD"}:
            raise APIError(405,"Метод не поддерживается.")
        suffix = path.removeprefix("/manage/pool/").split("/")
        token = suffix[0]
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}",token) or len(suffix)>2:
            raise APIError(404,"Ресурс не найден.")
        result = self.app.helper({"op":"bundle","token":token}).get("bundle")
        if not isinstance(result,dict):
            raise APIError(404,"Ресурс не найден.")
        profiles = result.get("profiles",[])
        if len(suffix)==2:
            filename = suffix[1]
            if filename == "bundle.zip":
                output = io.BytesIO()
                with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
                    for item in profiles:
                        profile = self.app.helper({"op":"bundle-profile","token":token,"id":item['id']}).get('bundle-profile')
                        if not isinstance(profile,dict):
                            continue
                        native = profile.get('protocol')=='amneziawg'
                        archive.writestr(item['id']+('.conf' if native else '.txt'),profile['configText'] if native else profile['uri']+'\n')
                        if not native:
                            archive.writestr(item['id']+'.json',json.dumps(profile['clientConfig'],ensure_ascii=False,indent=2))
                self.respond(200,output.getvalue(),{"Content-Type":"application/zip","Content-Disposition":'attachment; filename="signal-profiles.zip"'},head=head)
                return
            match = re.fullmatch(r"([0-9a-f-]{36})\.(conf|txt|json)",filename)
            if not match or not any(item['id']==match.group(1) for item in profiles):
                raise APIError(404,"Ресурс не найден.")
            profile = self.app.helper({"op":"bundle-profile","token":token,"id":match.group(1)}).get('bundle-profile')
            if not isinstance(profile,dict):
                raise APIError(404,"Ресурс не найден.")
            extension = match.group(2)
            native = profile.get('protocol')=='amneziawg'
            if (native and extension!='conf') or (not native and extension=='conf'):
                raise APIError(404,"Ресурс не найден.")
            text = profile['configText'] if native else json.dumps(profile['clientConfig'],indent=2) if extension=='json' else profile['uri']+'\n'
            self.respond(200,text.encode(),{"Content-Type":"text/plain; charset=utf-8",
                "Content-Disposition":'attachment; filename="'+filename+'"'},head=head)
            return
        labels = {'vless':'VLESS + XHTTP','trojan':'Trojan + XHTTP','vmess':'VMess AEAD + XHTTP',
                  'vless-reality':'VLESS + REALITY','amneziawg':'AmneziaWG 3.1'}
        cards = []
        for item in profiles:
            native = item.get('protocol')=='amneziawg'
            extension = '.conf' if native else '.txt'
            cards.append('<article class="bundle-card"><h2>'+html.escape(item['name'])+'</h2><p>'+labels.get(item.get('protocol'),'VPN')+
                '</p><a class="button button-primary" href="'+token+'/'+item['id']+extension+'">Скачать '+extension+'</a></article>')
        proxy = any(item.get('protocol')!='amneziawg' for item in profiles)
        subscription = ('<h2>Подписка для V2RayTun и Xray-клиентов</h2><p>Скопируйте этот адрес в «Добавить подписку». AmneziaWG в эту подписку не включён.</p><code>'+html.escape(result['subscriptionUrl'])+'</code>') if proxy else ''
        page = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Signal — набор профилей</title><link rel="stylesheet" href="/manage/style.css"><main class="bundle-page"><h1>'+html.escape(result['name'])+'</h1><p>Один набор, разные форматы подключения. Для AmneziaWG нужен клиент с поддержкой 3.1; для REALITY подойдёт V2RayTun.</p><a class="button button-secondary" href="'+token+'/bundle.zip">Скачать весь набор ZIP</a>'+subscription+''.join(cards)+'</main></html>'
        self.respond(200,page.encode(),{"Content-Type":"text/html; charset=utf-8"},head=head)

    def subscription(self, path: str, head: bool = False):
        if self.command not in {"GET", "HEAD"}:
            raise APIError(404, "Подписка не найдена.")
        token = path.removeprefix("/manage/sub/")
        if not SUBSCRIPTION_TOKEN.fullmatch(token):
            raise APIError(404, "Подписка не найдена.")
        result = self.app.helper({"op": "subscription", "token": token})
        subscription = result.get("subscription")
        if subscription is None:
            raise APIError(404, "Подписка не найдена.")
        if not isinstance(subscription, str) or not 1 <= len(subscription) <= 65536:
            raise APIError(502, "Некорректный ответ сервиса VPN.")
        self.respond(200, subscription.encode("ascii"), {"Content-Type": "text/plain; charset=utf-8"}, head=head)

    def api(self, path: str):
        token = self.cookie_token()
        session = self.app.session(token)
        if path == "/manage/api/session" and self.command == "GET":
            if session:
                self.respond(200, {"authenticated": True, "username": session["username"], "csrf": session["csrf"]})
            else:
                self.respond(200, {"authenticated": False})
            return
        body = self.mutation_body() if self.command in {"POST", "DELETE"} else None
        if path == "/manage/api/login" and self.command == "POST":
            self.app.limiter.reserve(self.client_ip())
            username, password = body.get("username"), body.get("password")
            if not isinstance(username, str) or not isinstance(password, str) or len(username) > 128 or len(password) > 1024:
                raise APIError(400, "Укажите имя пользователя и пароль.")
            if not self.app.password_matches(username, password):
                raise APIError(401, "Неверное имя пользователя или пароль.")
            if token and session:
                self.app.logout(token)
            new_token, csrf = self.app.create_session(username)
            self.respond(200, {"authenticated": True, "username": username, "csrf": csrf}, {"Set-Cookie": self.cookie(new_token)})
            return
        if not session:
            raise APIError(401, "Войдите в панель управления.")
        if body is not None:
            csrf = self.headers.get("X-CSRF-Token", "")
            if not hmac.compare_digest(csrf.encode("utf-8"), session["csrf"].encode("utf-8")):
                raise APIError(403, "Проверка запроса не пройдена. Обновите страницу.")
        if path == "/manage/api/logout" and self.command == "POST":
            self.app.logout(token)
            self.respond(200, {"ok": True}, {"Set-Cookie": self.cookie("", 0)})
        elif path == "/manage/api/status" and self.command == "GET":
            result = self.app.helper({"op": "status"})
            if not isinstance(result.get("status"), dict):
                raise APIError(502, "Некорректный ответ сервиса VPN.")
            allowed = {"online", "entryHost", "entryIp", "exitIp", "transport", "profilesCount", "protocols"}
            self.respond(200, {key: value for key, value in result["status"].items() if key in allowed})
        elif path == "/manage/api/profiles" and self.command == "GET":
            result = self.app.helper({"op": "list"})
            if not isinstance(result.get("profiles"), list):
                raise APIError(502, "Некорректный ответ сервиса VPN.")
            self.respond(200, {"profiles": result["profiles"]})
        elif path == "/manage/api/profiles" and self.command == "POST":
            name, device = body.get("name"), body.get("device")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 48 or any(ord(c) < 32 or ord(c) == 127 for c in name):
                raise APIError(400, "Название должно содержать от 1 до 48 символов.")
            if not isinstance(device, str) or device not in {"windows", "android", "other"}:
                raise APIError(400, "Выберите Windows, Android или другое устройство.")
            configuration, fingerprint = body.get("configuration", "packet-up"), body.get("fingerprint", "chrome")
            protocol = body.get("protocol", "vless")
            if not isinstance(protocol, str) or protocol not in {"vless", "trojan", "vmess","vless-reality","amneziawg"}:
                raise APIError(400, "Выберите поддерживаемый протокол.")
            if not isinstance(configuration, str) or configuration not in {"auto", "packet-up", "stream-up"}:
                raise APIError(400, "Выберите режим Auto, Packet-up или Stream-up.")
            if not isinstance(fingerprint, str) or fingerprint not in {"chrome", "firefox"}:
                raise APIError(400, "Выберите TLS-профиль Chrome или Firefox.")
            result = self.app.helper({"op": "create", "name": name.strip(), "device": device,
                                      "configuration": configuration, "fingerprint": fingerprint, "protocol": protocol})
            if not isinstance(result.get("profile"), dict):
                raise APIError(502, "Некорректный ответ сервиса VPN.")
            self.respond(201, {"profile": result["profile"]})
        elif path.startswith("/manage/api/profiles/") and self.command in {"GET", "DELETE"}:
            profile_id = path.removeprefix("/manage/api/profiles/")
            if not PROFILE_ID.fullmatch(profile_id):
                raise APIError(400, "Некорректный идентификатор подключения.")
            if self.command == "DELETE":
                self.app.helper({"op": "revoke", "id": profile_id})
                self.respond(200, {"ok": True})
            else:
                result = self.app.helper({"op": "get", "id": profile_id})
                if not isinstance(result.get("profile"), dict):
                    raise APIError(502, "Некорректный ответ сервиса VPN.")
                self.respond(200, {"profile": result["profile"]})
        elif path == "/manage/api/pools" and self.command == "GET":
            result = self.app.helper({"op": "pool-list"})
            if not isinstance(result.get("pools"), list):
                raise APIError(502, "Некорректный ответ сервиса VPN.")
            self.respond(200, {"pools": result["pools"]})
        elif path == "/manage/api/pools" and self.command == "POST":
            name, ids = body.get("name"), body.get("profileIds")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 48 or any(ord(c) < 32 or ord(c) == 127 for c in name):
                raise APIError(400, "Название должно содержать от 1 до 48 символов.")
            if not isinstance(ids, list) or not 1 <= len(ids) <= 50 or any(not isinstance(identifier, str) or not PROFILE_ID.fullmatch(identifier) for identifier in ids) or len(set(ids)) != len(ids):
                raise APIError(400, "Выберите от 1 до 50 разных активных профилей.")
            result = self.app.helper({"op": "pool-create", "name": name.strip(), "profileIds": ids})
            self.pool_response(result, status=201)
        elif path.startswith("/manage/api/pools/"):
            suffix = path.removeprefix("/manage/api/pools/")
            identifier = suffix.removesuffix("/rotate")
            if not PROFILE_ID.fullmatch(identifier):
                raise APIError(400, "Некорректный идентификатор пула.")
            if suffix == identifier and self.command == "GET":
                self.pool_response(self.app.helper({"op": "pool-get", "id": identifier}))
            elif suffix == identifier and self.command == "DELETE":
                self.app.helper({"op": "pool-revoke", "id": identifier})
                self.respond(200, {"ok": True})
            elif suffix == identifier + "/rotate" and self.command == "POST":
                self.pool_response(self.app.helper({"op": "pool-rotate", "id": identifier}))
            else:
                raise APIError(404, "Ресурс не найден.")
        else:
            raise APIError(404, "Ресурс не найден.")

    def pool_response(self, result: dict, status: int = 200):
        if not isinstance(result.get("pool"), dict):
            raise APIError(502, "Некорректный ответ сервиса VPN.")
        self.respond(status, {"pool": result["pool"]})

    def static(self, path: str, head: bool = False):
        if not path.startswith("/manage/"):
            raise APIError(404, "Страница не найдена.")
        try:
            relative = unquote(path[len("/manage/"):], errors="strict") or "index.html"
            if "\\" in relative or "\x00" in relative or any(part.startswith(".") for part in relative.split("/")):
                raise ValueError("unsafe path")
            file_path = (self.app.web_root / relative).resolve()
            file_path.relative_to(self.app.web_root)
            allowed = {".html", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".txt"}
            if file_path.suffix.lower() not in allowed or not file_path.is_file() or file_path.stat().st_size > 5 * 1024 * 1024:
                raise ValueError("not a public file")
            data = file_path.read_bytes()
        except (OSError, ValueError, UnicodeDecodeError):
            raise APIError(404, "Страница не найдена.") from None
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if file_path.suffix.lower() in {".js", ".css", ".html", ".txt", ".svg"}:
            content_type += "; charset=utf-8"
        self.respond(200, data, {"Content-Type": content_type}, head=head)


def create_server(config: Config, controller: Callable[[dict], dict] | None = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", config.port), Handler)
    server.daemon_threads = True
    server.app = Application(config, controller)
    return server


def main():
    os.umask(0o077)
    server = create_server(Config.from_environment())
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
