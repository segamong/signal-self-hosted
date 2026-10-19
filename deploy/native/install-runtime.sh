#!/usr/bin/env bash
# Installs only private runtime files under /opt/signal. No apt, Docker or firewall changes.
set -euo pipefail
umask 022
[[ "$(id -u)" == 0 && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { printf 'Root on Linux x86_64 required.\n' >&2; exit 1; }
for executable in curl tar xz sha256sum sha512sum awk install; do command -v "$executable" >/dev/null || { printf 'Missing: %s\n' "$executable" >&2; exit 1; }; done
base=/opt/signal
if [[ -d "$base" && ! -f "$base/.signal-managed" && -n "$(find "$base" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  printf 'Refusing unknown non-empty /opt/signal.\n' >&2; exit 1
fi
install -d -m 0755 "$base" "$base/runtime" "$base/runtime/bin"
install -d -m 0700 "$base/cache"
printf 'signal-native-v1\n' > "$base/.signal-managed"
cd "$base/cache"
fetch() { local url="$1" filename="$2"; curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 180 --output "$filename.part" "$url"; mv -- "$filename.part" "$filename"; }
verify() { local tool="$1" manifest="$2" filename="$3"; local line; line="$(awk -v file="$filename" '$2 == file {print}' "$manifest")"; [[ -n "$line" ]] || { printf 'Missing checksum for %s\n' "$filename" >&2; exit 1; }; printf '%s\n' "$line" | "$tool" --check --status; }

node_archive=node-v24.19.0-linux-x64.tar.xz
fetch "https://nodejs.org/download/release/v24.19.0/$node_archive" "$node_archive"
fetch 'https://nodejs.org/download/release/v24.19.0/SHASUMS256.txt' node-SHASUMS256.txt
verify sha256sum node-SHASUMS256.txt "$node_archive"
printf '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  %s\n' "$node_archive" | sha256sum --check --status
tar --extract --xz --file "$node_archive" --directory "$base/runtime" --no-same-owner

livekit_archive=livekit_1.13.10_linux_amd64.tar.gz
fetch "https://github.com/livekit/livekit/releases/download/v1.13.10/$livekit_archive" "$livekit_archive"
fetch 'https://github.com/livekit/livekit/releases/download/v1.13.10/checksums.txt' livekit-checksums.txt
verify sha256sum livekit-checksums.txt "$livekit_archive"
printf 'c25a3e45fb922e9a93c6443d10c0ed041ba64342097e38632331736630283165  %s\n' "$livekit_archive" | sha256sum --check --status
install -d -m 0700 livekit-extract
tar --extract --gzip --file "$livekit_archive" --directory livekit-extract --no-same-owner
install -m 0755 livekit-extract/livekit-server "$base/runtime/bin/livekit-server"

caddy_archive=caddy_2.11.7_linux_amd64.tar.gz
fetch "https://github.com/caddyserver/caddy/releases/download/v2.11.7/$caddy_archive" "$caddy_archive"
fetch 'https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_checksums.txt' caddy-checksums.txt
verify sha512sum caddy-checksums.txt "$caddy_archive"
printf '727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b  %s\n' "$caddy_archive" | sha256sum --check --status
install -d -m 0700 caddy-extract
tar --extract --gzip --file "$caddy_archive" --directory caddy-extract --no-same-owner
install -m 0755 caddy-extract/caddy "$base/runtime/bin/caddy"
chown -R root:root "$base/runtime"
chmod -R go-w "$base/runtime"
"$base/runtime/node-v24.19.0-linux-x64/bin/node" --version
"$base/runtime/bin/livekit-server" --version
"$base/runtime/bin/caddy" version
printf 'Private runtime installed. No services started.\n'
