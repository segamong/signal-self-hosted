"""Gateway integration tests using temporary credentials and a fake controller."""

import base64
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from app import Application, Config, Handler, LoginLimiter, APIError
from http.server import ThreadingHTTPServer


ORIGIN = "https://vpn.signal-on.ru"
TEST_PASSWORD = "temporary-test-password"
PROFILE_ID = "a835c5ee-16bb-4b61-8de5-4c2fb0064039"
POOL_ID = "ab35c5ee-16bb-4b61-8de5-4c2fb0064039"
SUB_TOKEN = "A" * 43


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        salt = b"temporary-test-salt-32-characters"
        cls.auth = {
            "username": "admin", "salt": base64.b64encode(salt).decode(),
            "passwordHash": base64.b64encode(hashlib.scrypt(
                TEST_PASSWORD.encode(), salt=salt, n=32768, r=8, p=1,
                dklen=32, maxmem=64 * 1024 * 1024,
            )).decode(), "n": 32768, "r": 8, "p": 1,
        }

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        web = root / "web"
        web.mkdir()
        (web / "index.html").write_text("<!doctype html><title>VPN</title>", encoding="utf-8")
        (web / "app.js").write_text("'use strict';", encoding="utf-8")
        (root / "private.txt").write_text("never public", encoding="utf-8")
        (web / ".hidden.txt").write_text("never public", encoding="utf-8")
        auth_file = root / "auth.json"
        auth_file.write_text(json.dumps(self.auth), encoding="utf-8")
        self.requests = []
        self.profile = {
            "id": PROFILE_ID, "name": "Телефон", "device": "android",
            "createdAt": "2026-10-26T19:00:00Z", "active": True,
            "uri": "vless://test-only", "clientConfig": {"test": True},
        }
        self.controller_error = None
        self.pool = {"id":POOL_ID,"name":"Пул","profileIds":[PROFILE_ID],"active":True,
                     "createdAt":"2026-10-26T19:00:00Z","activeProfilesCount":1,
                     "subscriptionUrl":ORIGIN + "/manage/sub/" + SUB_TOKEN}
        self.subscription = base64.b64encode(b"vless://test-only\n").decode()
        self.app = Application(Config(web, auth_file, root / "state", "unused"), self.controller)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.app = self.app
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.cookie = None
        self.csrf = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def controller(self, data):
        self.requests.append(data)
        if self.controller_error:
            return {"ok": False, "error": self.controller_error}
        operation = data["op"]
        if operation == "status":
            return {"ok": True, "status": {
                "online": True, "entryHost": "vpn.signal-on.ru", "entryIp": "177.3.212.182",
                "exitIp": "177.3.212.182", "transport": "VLESS / XHTTP / TLS 1.3",
                "profilesCount": 1, "privateInternalData": "must not escape",
            }}
        if operation == "list":
            return {"ok": True, "profiles": [self.profile]}
        if operation in {"create", "get"}:
            return {"ok": True, "profile": self.profile}
        if operation == "revoke":
            return {"ok": True}
        if operation == "pool-list":
            return {"ok":True,"pools":[self.pool]}
        if operation in {"pool-create","pool-get","pool-rotate"}:
            return {"ok":True,"pool":self.pool}
        if operation == "pool-revoke":
            return {"ok":True}
        if operation == "subscription":
            return {"ok":True,"subscription":self.subscription if data["token"]==SUB_TOKEN else None}
        if operation == "bundle":
            return {"ok":True,"bundle":{"name":"Пул <script>","profiles":[{"id":PROFILE_ID,"name":"Телефон","protocol":"vless"}],"subscriptionUrl":ORIGIN+'/manage/sub/'+SUB_TOKEN} if data['token']==SUB_TOKEN else None}
        if operation == "bundle-profile":
            return {"ok":True,"bundle-profile":self.profile if data['token']==SUB_TOKEN and data.get('id')==PROFILE_ID else None}
        raise AssertionError(operation)

    def request(self, method, path, payload=None, headers=None):
        request_headers = dict(headers or {})
        if self.cookie:
            request_headers.setdefault("Cookie", self.cookie)
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            request_headers.setdefault("Content-Type", "application/json")
            request_headers.setdefault("Origin", ORIGIN)
            request_headers.setdefault("Content-Length", str(len(body)))
            if self.csrf:
                request_headers.setdefault("X-CSRF-Token", self.csrf)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        status, response_headers, data = response.status, response.getheaders(), response.read()
        connection.close()
        if dict(response_headers).get("Content-Type", "").startswith("application/json"):
            data = json.loads(data)
        return status, dict(response_headers), data, response_headers

    def login(self):
        status, headers, data, _ = self.request("POST", "/manage/api/login", {"username": "admin", "password": TEST_PASSWORD})
        self.assertEqual(status, 200)
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.csrf = data["csrf"]
        return headers, data

    def test_session_lifecycle_hashed_storage_and_secure_cookie(self):
        status, _, data, _ = self.request("GET", "/manage/api/session")
        self.assertEqual((status, data), (200, {"authenticated": False}))
        headers, data = self.login()
        cookie = headers["Set-Cookie"]
        for attribute in ("__Secure-signalvpn=", "Secure", "HttpOnly", "SameSite=Strict", "Path=/manage/", "Max-Age=28800"):
            self.assertIn(attribute, cookie)
        token = self.cookie.split("=", 1)[1]
        with self.app.connect() as db:
            stored = db.execute("SELECT token_hash FROM sessions").fetchone()[0]
        self.assertNotEqual(stored, token)
        self.assertEqual(stored, hashlib.sha256(token.encode()).hexdigest())
        self.assertEqual(self.request("GET", "/manage/api/session")[2], data)
        self.assertEqual(self.request("POST", "/manage/api/logout", {})[0], 200)
        self.assertEqual(self.request("GET", "/manage/api/session")[2], {"authenticated": False})

    def test_origin_and_csrf_are_required_before_profile_mutations(self):
        self.login()
        payload = {"name": "Телефон", "device": "android"}
        for headers in ({"Origin": "https://attacker.example"}, {"Origin": "null"}, {"X-CSRF-Token": "bad"}, {"X-CSRF-Token": ""}):
            self.assertEqual(self.request("POST", "/manage/api/profiles", payload, headers)[0], 403)
        self.assertEqual(self.requests, [])
        status, _, data, _ = self.request("POST", "/manage/api/profiles", payload)
        self.assertEqual(status, 201)
        self.assertEqual(data["profile"]["id"], PROFILE_ID)
        self.assertEqual(self.requests, [{"op": "create", **payload, "configuration":"packet-up", "fingerprint":"chrome", "protocol":"vless"}])

    def test_profile_options_are_forwarded_and_reject_unknown_values(self):
        self.login()
        payload = {"name":"Режим","device":"windows","configuration":"stream-up","fingerprint":"firefox"}
        self.assertEqual(self.request("POST","/manage/api/profiles",payload)[0],201)
        self.assertEqual(self.requests[-1],{"op":"create",**payload,"protocol":"vless"})
        count = len(self.requests)
        for field, value in [("configuration","none"),("fingerprint","random"),("configuration",[]),("fingerprint",{})]:
            self.assertEqual(self.request("POST","/manage/api/profiles",{**payload,field:value})[0],400)
        self.assertEqual(len(self.requests),count)

    def test_real_protocol_choices_are_validated_and_forwarded(self):
        self.login()
        for protocol in ('vless','trojan','vmess'):
            payload = {"name":"Протокол","device":"android","protocol":protocol}
            self.assertEqual(self.request("POST","/manage/api/profiles",payload)[0],201)
            self.assertEqual(self.requests[-1],{"op":"create",**payload,"configuration":"packet-up","fingerprint":"chrome"})
        count = len(self.requests)
        for protocol in ('shadowsocks',None,[],{}):
            self.assertEqual(self.request("POST","/manage/api/profiles",{**payload,"protocol":protocol})[0],400)
        self.assertEqual(len(self.requests),count)

    def test_pool_apis_require_authentication_origin_csrf_and_valid_selection(self):
        path = "/manage/api/pools"
        self.assertEqual(self.request("GET",path)[0],401)
        self.assertEqual(self.request("POST",path,{"name":"Пул","profileIds":[PROFILE_ID]})[0],401)
        self.assertEqual(self.requests,[])
        self.login()
        payload = {"name":"Пул","profileIds":[PROFILE_ID]}
        for method, url in [("POST",path),("POST",path+"/"+POOL_ID+"/rotate"),("DELETE",path+"/"+POOL_ID)]:
            for headers in [{"Origin":"https://attacker.example"},{"X-CSRF-Token":"bad"}]:
                self.assertEqual(self.request(method,url,payload,headers)[0],403)
        for ids in [[],[PROFILE_ID,PROFILE_ID],["not-a-uuid"],[{}]]:
            self.assertEqual(self.request("POST",path,{**payload,"profileIds":ids})[0],400)
        self.assertEqual(self.requests,[])
        self.assertEqual(self.request("POST",path,payload)[0],201)
        self.assertEqual(self.requests[-1],{"op":"pool-create",**payload})
        self.assertEqual(self.request("GET",path)[2],{"pools":[self.pool]})
        self.assertEqual(self.request("GET",path+"/"+POOL_ID)[2],{"pool":self.pool})
        self.assertEqual(self.request("POST",path+"/"+POOL_ID+"/rotate",{})[2],{"pool":self.pool})
        self.assertEqual(self.requests[-1],{"op":"pool-rotate","id":POOL_ID})
        self.assertEqual(self.request("DELETE",path+"/"+POOL_ID,{})[2],{"ok":True})
        self.assertEqual(self.requests[-1],{"op":"pool-revoke","id":POOL_ID})

    def test_bundle_download_is_token_scoped_and_html_escapes_names(self):
        path='/manage/pool/'+SUB_TOKEN
        status,headers,body,_=self.request('GET',path)
        self.assertEqual(status,200)
        self.assertIn('no-store',headers['Cache-Control'])
        self.assertIn(b'&lt;script&gt;',body)
        self.assertNotIn(b'<script>',body)
        self.assertEqual(self.request('GET',path+'/'+PROFILE_ID+'.txt')[0],200)
        self.assertEqual(self.request('GET',path+'/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.conf')[0],404)
        self.assertEqual(self.request('GET','/manage/pool/'+'B'*43)[0],404)
        self.assertEqual(self.request('POST',path,{})[0],405)
        response=self.request('GET',path+'/bundle.zip')
        self.assertEqual(response[0],200)
        self.assertEqual(response[1]['Content-Type'],'application/zip')

    def test_subscription_is_public_bearer_scoped_and_not_cached(self):
        # This endpoint intentionally works without login; no other API becomes public.
        path = "/manage/sub/" + SUB_TOKEN
        response = self.request("GET",path)
        self.assertEqual(response[0],200)
        self.assertEqual(base64.b64decode(response[2]),b"vless://test-only\n")
        self.assertEqual(response[1]["Cache-Control"],"no-store")
        self.assertEqual(response[1]["Referrer-Policy"],"no-referrer")
        self.assertEqual(self.requests,[{"op":"subscription","token":SUB_TOKEN}])
        self.assertEqual(self.request("GET","/manage/api/pools")[0],401)
        self.assertEqual(self.request("POST",path,{})[0],404)
        count = len(self.requests)
        self.assertEqual(self.request("GET","/manage/sub/invalid")[0],404)
        self.assertEqual(self.request("GET",path+"/anything")[0],404)
        self.assertEqual(len(self.requests),count)
        missing = self.request("GET","/manage/sub/"+"B"*43)
        self.assertEqual(missing[0],404)
        self.subscription = None
        self.assertEqual(self.request("GET",path)[2],missing[2])

    def test_private_api_status_export_and_revocation(self):
        self.assertEqual(self.request("GET", "/manage/api/status")[0], 401)
        self.assertEqual(self.request("GET", "/manage/api/profiles")[0], 401)
        self.assertEqual(self.requests, [])
        self.login()
        status = self.request("GET", "/manage/api/status")[2]
        self.assertEqual(status["entryIp"], "177.3.212.182")
        self.assertNotIn("privateInternalData", status)
        self.assertEqual(self.request("GET", "/manage/api/profiles")[2]["profiles"][0]["id"], PROFILE_ID)
        self.assertEqual(self.request("GET", "/manage/api/profiles/" + PROFILE_ID)[2]["profile"]["clientConfig"], {"test": True})
        self.assertEqual(self.request("DELETE", "/manage/api/profiles/" + PROFILE_ID, {})[2], {"ok": True})
        self.assertEqual(self.requests[-1], {"op": "revoke", "id": PROFILE_ID})

    def test_credential_failure_expiry_and_login_rate_limit(self):
        bad = {"username": "admin", "password": "wrong-test-password"}
        self.assertEqual(self.request("POST", "/manage/api/login", bad)[0], 401)
        self.login()
        with self.app.connect() as db:
            db.execute("UPDATE sessions SET expires = ?", (int(time.time()) - 1,))
        self.assertEqual(self.request("GET", "/manage/api/session")[2], {"authenticated": False})
        self.app.limiter = LoginLimiter()
        for _ in range(10):
            self.app.limiter.reserve("198.51.100.12")
        response = self.request("POST", "/manage/api/login", bad, {"X-Forwarded-For": "203.0.113.99, 198.51.100.12"})
        self.assertEqual(response[0], 429)
        self.assertEqual(response[1]["Retry-After"], "900")

    def test_static_traversal_and_response_headers(self):
        for path in ("/manage/../private.txt", "/manage/%2e%2e/private.txt", "/manage/%2e%2e%5cprivate.txt", "/manage/.hidden.txt", "/auth.json"):
            self.assertEqual(self.request("GET", path)[0], 404, path)
        response = self.request("GET", "/manage/app.js")
        self.assertEqual(response[0], 200)
        self.assertEqual(len([item for item in response[3] if item[0] == "Content-Type"]), 1)
        self.assertIn("javascript", response[1]["Content-Type"])
        self.assertEqual(response[1]["Cache-Control"], "no-store")
        self.assertIn("frame-ancestors 'none'", response[1]["Content-Security-Policy"])
        self.assertEqual(response[1]["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.request("GET", "/manage")[1]["Location"], "/manage/")

    def test_invalid_json_input_and_controlled_helper_error(self):
        self.login()
        for payload in ({"name": "", "device": "android"}, {"name": "x" * 49, "device": "android"}, {"name": "x", "device": []}):
            self.assertEqual(self.request("POST", "/manage/api/profiles", payload)[0], 400)
        self.assertEqual(self.request("POST", "/manage/api/profiles", {}, {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("GET", "/manage/api/profiles/not-a-uuid")[0], 400)
        self.controller_error = "Профиль не найден."
        response = self.request("GET", "/manage/api/profiles/" + PROFILE_ID)
        self.assertEqual((response[0], response[2]), (502, {"error": self.controller_error}))

    def test_http_requires_explicit_local_preview(self):
        base = dict(web_root=Path("."), auth_file=Path("auth"), state_dir=Path("state"), control_socket="unused")
        with self.assertRaises(ValueError):
            Config(**base, public_origin="http://127.0.0.1:3180")
        with self.assertRaises(ValueError):
            Config(**base, public_origin="http://public.example", allow_http_local=True)
        local = Config(**base, public_origin="http://127.0.0.1:3180", allow_http_local=True)
        self.assertFalse(local.secure_cookie)
        self.assertEqual(local.cookie_name, "signalvpn")


if __name__ == "__main__":
    unittest.main(verbosity=2)
