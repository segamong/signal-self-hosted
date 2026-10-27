#!/usr/bin/env python3
"""Loopback-only browser QA of the real Signal frontend.

This preview never connects to the VPN server, opens SSH, or reads production
credentials. Its known password and disposable profiles are only test fixtures.
Run locally, then open http://127.0.0.1:3181/manage/.
"""

from __future__ import annotations

import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import tempfile
import threading
from urllib.parse import quote, urlencode
import uuid

from app import Config, create_server


PREVIEW_ORIGIN = "http://127.0.0.1:3181"
PREVIEW_PASSWORD = "qa-preview-only"


class PreviewController:
    """In-memory fixture implementing the production controller contract."""

    def __init__(self):
        self.lock = threading.RLock()
        self.profiles: dict[str, dict] = {}
        self.pools: dict[str, dict] = {}

    def create_profile(self, name: str, device: str, configuration: str = "packet-up", fingerprint: str = "chrome", protocol: str = "vless") -> dict:
        if protocol not in ("vless", "trojan", "vmess", "vless-reality", "amneziawg"):
            raise ValueError("Неизвестный тестовый протокол.")
        profile_id = str(uuid.uuid4())
        # .invalid is deliberately unusable: preview exports cannot connect to
        # a real endpoint even though the UI's primary IP matches production.
        host = "preview.invalid"
        path = "/local-preview-only/" + protocol + "/"
        credentials = secrets.token_urlsafe(32) if protocol == "trojan" else str(uuid.uuid4())
        parameters = {
            "security": "tls", "sni": host,
            "type": "xhttp", "path": path, "mode": configuration,
            "fp": fingerprint, "alpn": "h2",
        }
        if protocol == "vless":
            parameters["encryption"] = "none"
        query = urlencode(parameters, quote_via=quote)
        if protocol == "trojan":
            settings = {"servers": [{"address": host, "port": 443, "password": credentials}]}
        else:
            user = {"id": credentials, "security": "auto"} if protocol == "vmess" else {"id": credentials, "encryption": "none"}
            settings = {"vnext": [{"address": host, "port": 443, "users": [user]}]}
        profile = {
            "id": profile_id,
            "name": name,
            "device": device,
            "protocol": protocol,
            "configuration": configuration,
            "fingerprint": fingerprint,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "active": True,
            "uri": f"{protocol}://{quote(credentials, safe='')}@{host}:443?{query}#{quote(name)}",
            "clientConfig": {
                "log": {"loglevel": "warning"},
                "inbounds": [{
                    "listen": "127.0.0.1", "port": 10808, "protocol": "socks",
                    "settings": {"udp": True},
                }],
                "outbounds": [{
                    "tag": "preview-only", "protocol": protocol,
                    "settings": settings,
                    "streamSettings": {
                        "network": "xhttp", "security": "tls",
                        "tlsSettings": {"serverName": host, "minVersion": "1.3", "allowInsecure": False,
                                        "fingerprint": fingerprint, "alpn": ["h2"]},
                        "xhttpSettings": {"path": path, "mode": configuration, "xPaddingBytes": "100-1000"},
                    },
                }],
            },
        }
        if protocol == "vless-reality":
            profile.update(configuration="tcp", security="REALITY · XTLS Vision",
                uri=f"vless://{credentials}@preview.invalid:443?security=reality&type=tcp&flow=xtls-rprx-vision#preview",
                clientHint="Локальный тестовый профиль REALITY. Адрес preview.invalid не работает.")
        if protocol == "amneziawg":
            profile.update(configuration="udp", fingerprint="none", security="AmneziaWG 3.1 · ChaCha20-Poly1305",
                uri=None, clientConfig=None, downloadFormat="conf",
                configText="[Interface]\nPrivateKey = PREVIEW-ONLY-NOT-A-REAL-KEY\nAddress = 10.89.0.2/32\nMTU = 1280\n\n[Peer]\nPublicKey = PREVIEW-ONLY-NOT-A-REAL-KEY\nEndpoint = preview.invalid:443\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n",
                clientHint="Нужен клиент AmneziaWG с поддержкой 3.1. Тестовый файл не подключается.")
        profile["qrValue"] = profile.get("configText") or profile["uri"]
        self.profiles[profile_id] = profile
        return copy.deepcopy(profile)

    def public_pool(self, pool: dict) -> dict:
        native = any(self.profiles.get(identifier, {}).get("protocol") == "amneziawg"
                     for identifier in pool["profileIds"])
        subscription = "https://preview.invalid/manage/sub/" + pool["token"] if pool["active"] else None
        bundle = "https://preview.invalid/manage/pool/" + pool["token"] if pool["active"] else None
        return {
            key: copy.deepcopy(pool[key]) for key in ("id", "name", "profileIds", "active", "createdAt")
        } | {
            "activeProfilesCount": sum(self.profiles.get(identifier, {}).get("active", False)
                                       for identifier in pool["profileIds"]),
            "subscriptionUrl": subscription,
            "bundleUrl": bundle, "hasNativeProfiles": native,
            "qrUrl": bundle if native else subscription,
        }

    def __call__(self, request: dict) -> dict:
        with self.lock:
            operation = request.get("op")
            if operation == "status":
                return {"ok": True, "status": {
                    "online": True,
                    "entryHost": "Локальный предпросмотр · тестовые профили",
                    "entryIp": "177.3.212.182",
                    "exitIp": "177.3.212.182",
                    "transport": "XHTTP / TLS 1.3",
                    "protocols": ["vless", "trojan", "vmess", "vless-reality", "amneziawg"],
                    "profilesCount": sum(profile["active"] for profile in self.profiles.values()),
                }}
            if operation == "list":
                fields = {"id", "name", "device", "protocol", "configuration", "fingerprint", "createdAt", "active"}
                return {"ok": True, "profiles": [
                    {key: value for key, value in profile.items() if key in fields}
                    for profile in self.profiles.values()
                ]}
            if operation == "create":
                return {"ok": True, "profile": self.create_profile(request["name"], request["device"],
                        request.get("configuration", "packet-up"), request.get("fingerprint", "chrome"), request.get("protocol", "vless"))}
            if operation == "get":
                profile = self.profiles.get(request.get("id"))
                if profile is not None and profile["active"]:
                    return {"ok": True, "profile": copy.deepcopy(profile)}
            if operation == "revoke" and request.get("id") in self.profiles:
                self.profiles[request["id"]]["active"] = False
                return {"ok": True}
            if operation == "pool-list":
                return {"ok": True, "pools": [self.public_pool(pool) for pool in self.pools.values()]}
            if operation == "pool-create":
                identifiers = request["profileIds"]
                if any(not self.profiles.get(identifier, {}).get("active") for identifier in identifiers):
                    return {"ok": False, "error": "Выберите только активные тестовые профили."}
                identifier = str(uuid.uuid4())
                pool = {"id": identifier, "name": request["name"], "profileIds": list(identifiers),
                        "active": True, "createdAt": datetime.now(timezone.utc).isoformat(),
                        "token": secrets.token_urlsafe(32)}
                self.pools[identifier] = pool
                return {"ok": True, "pool": self.public_pool(pool)}
            if operation == "subscription":
                pool = next((pool for pool in self.pools.values()
                             if pool["active"] and pool["token"] == request.get("token")), None)
                profiles = [self.profiles[identifier] for identifier in pool["profileIds"]
                            if self.profiles.get(identifier, {}).get("active")] if pool else []
                return {"ok": True, "subscription": base64.b64encode(
                    ("\n".join(profile["uri"] for profile in profiles if profile.get("uri")) + "\n").encode()
                ).decode("ascii") if profiles else None}
            if operation in {"pool-get", "pool-revoke", "pool-rotate"}:
                pool = self.pools.get(request.get("id"))
                if pool is not None:
                    if operation == "pool-revoke":
                        pool["active"] = False
                        return {"ok": True}
                    if operation == "pool-rotate":
                        if not pool["active"]:
                            return {"ok": False, "error": "Тестовый пул отключён."}
                        pool["token"] = secrets.token_urlsafe(32)
                    return {"ok": True, "pool": self.public_pool(pool)}
            return {"ok": False, "error": "Тестовый профиль не найден."}


def main():
    with tempfile.TemporaryDirectory(prefix="signal-vpn-local-preview-") as directory:
        root = Path(directory)
        salt = secrets.token_bytes(32)
        password_hash = hashlib.scrypt(
            PREVIEW_PASSWORD.encode("utf-8"), salt=salt, n=32768, r=8, p=1,
            dklen=32, maxmem=64 * 1024 * 1024,
        )
        auth_file = root / "preview-auth.json"
        auth_file.write_text(json.dumps({
            "username": "admin", "n": 32768, "r": 8, "p": 1,
            "salt": base64.b64encode(salt).decode("ascii"),
            "passwordHash": base64.b64encode(password_hash).decode("ascii"),
        }), encoding="utf-8")
        config = Config(
            web_root=Path(__file__).resolve().parent / "web",
            auth_file=auth_file,
            state_dir=root / "sessions",
            control_socket="unused-local-preview",
            public_origin=PREVIEW_ORIGIN,
            port=3181,
            allow_http_local=True,
        )
        server = create_server(config, PreviewController())
        print(f"LOCAL PREVIEW ONLY: {PREVIEW_ORIGIN}/manage/", flush=True)
        print("No production connections. User: admin; password: qa-preview-only", flush=True)
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
