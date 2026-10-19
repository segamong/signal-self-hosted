#!/usr/bin/env bash
# First native install, or rerun while all three Signal services are stopped.
# Other services and networking are never changed.
set -euo pipefail
umask 022
native_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd -- "$native_dir/../.." && pwd)"
server_ip="${1:?Usage: bash deploy/native/install.sh SERVER_IPV4 [HTTPS_PORT]}"
https_port="${2:-9443}"
base=/opt/signal
[[ "$(id -u)" == 0 && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { printf 'Root on Linux x86_64 required.\n' >&2; exit 1; }
for executable in systemctl getent useradd groupadd install tar ss; do command -v "$executable" >/dev/null || { printf 'Missing: %s\n' "$executable" >&2; exit 1; }; done
for service in signal-app signal-media signal-caddy; do
  if systemctl is-active --quiet "$service"; then printf '%s is running. Stop only Signal services before updating.\n' "$service" >&2; exit 1; fi
done
[[ -f "$source_dir/package-lock.json" && -f "$source_dir/dist/index.html" && -f "$source_dir/server/index.mjs" ]] || { printf 'Bundle must include package-lock.json, prebuilt dist/index.html and server/index.mjs.\n' >&2; exit 1; }
if [[ -d "$base" && ! -f "$base/.signal-managed" && -n "$(find "$base" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then printf 'Refusing unknown non-empty /opt/signal.\n' >&2; exit 1; fi

cd "$source_dir"
bash "$source_dir/deploy/preflight.sh" --check-ports --https-port "$https_port"
bash "$native_dir/install-runtime.sh"
node_dir="$base/runtime/node-v24.19.0-linux-x64/bin"
export PATH="$node_dir:$PATH"

ensure_user() {
  local account="$1" expected_home="$2" current_home current_shell
  if getent passwd "$account" >/dev/null; then
    current_home="$(getent passwd "$account" | cut -d: -f6)"
    current_shell="$(getent passwd "$account" | cut -d: -f7)"
    [[ "$current_home" == "$expected_home" && "$current_shell" == /usr/sbin/nologin ]] || { printf 'Refusing existing unrelated account %s.\n' "$account" >&2; exit 1; }
  else
    useradd --system --user-group --home-dir "$expected_home" --shell /usr/sbin/nologin "$account"
  fi
  install -d -m 0700 -o "$account" -g "$account" "$expected_home"
}
ensure_user signal /var/lib/signal
ensure_user signal-media /var/lib/signal-media
ensure_user signal-caddy /var/lib/signal-caddy
install -d -m 0755 -o root -g root /etc/signal

staging="$(mktemp -d "$base/staging.XXXXXX")"
tar -C "$source_dir" -cf - server dist package.json package-lock.json deploy README.ru.md | tar -C "$staging" -xf - --no-same-owner
cd "$staging"
node "$node_dir/../lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:root "$staging"
chmod -R go-w "$staging"
chmod 0755 "$staging"
node "$staging/deploy/native/configure.mjs" --server-ip "$server_ip" --https-port "$https_port" --check-dns
chown root:root /etc/signal/settings.env /etc/signal/app.env
chmod 0600 /etc/signal/settings.env /etc/signal/app.env
chown root:signal-media /etc/signal/livekit.yaml
chown root:signal-caddy /etc/signal/Caddyfile
chmod 0640 /etc/signal/livekit.yaml /etc/signal/Caddyfile

# Static adaptation checks the Caddyfile without opening listeners or requesting certs.
"$base/runtime/bin/caddy" adapt --config /etc/signal/Caddyfile --adapter caddyfile >/dev/null
if [[ -d "$base/app" ]]; then mv -- "$base/app" "$base/app.previous.$(date -u +%Y%m%dT%H%M%SZ)"; fi
mv -- "$staging" "$base/app"
install -m 0644 "$base/app/deploy/native/signal-app.service" /etc/systemd/system/signal-app.service
install -m 0644 "$base/app/deploy/native/signal-media.service" /etc/systemd/system/signal-media.service
install -m 0644 "$base/app/deploy/native/signal-caddy.service" /etc/systemd/system/signal-caddy.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/signal-app.service /etc/systemd/system/signal-media.service /etc/systemd/system/signal-caddy.service
printf '\nInstalled without starting. Start only these three units when ready:\n'
printf 'systemctl enable --now signal-media signal-app signal-caddy\n'
printf 'Admin credentials are stored locally in /etc/signal/settings.env (root only).\n'
printf 'Validate HTTPS, media from external clients, and VPN after starting.\n'
