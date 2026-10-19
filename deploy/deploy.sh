#!/usr/bin/env bash
# First deployment only. Run from the extracted project on the target Linux server.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077

[[ "$(uname -s)" == Linux ]] || { printf 'Linux host networking is required.\n' >&2; exit 1; }
command -v docker >/dev/null || { printf 'Install Docker Engine and the Compose plugin before deployment.\n' >&2; exit 1; }
docker info >/dev/null
docker compose version >/dev/null
[[ -f .env ]] || { printf 'Create deploy/.env with generate-env.mjs first (see README.ru.md).\n' >&2; exit 1; }
chmod 600 .env

if [[ -n "$(docker compose -f compose.yaml ps -q --status running 2>/dev/null)" ]]; then
  printf 'Signal stack is already running. Use the documented update procedure; this script does not stop running services.\n' >&2
  exit 1
fi

# Restricted parser: never execute .env as shell code.
https_port="$(awk -F= '$1 == "HTTPS_PORT" {print $2}' .env)"
turn_enabled="$(awk -F= '$1 == "TURN_ENABLED" {print $2}' .env)"
args=(--check-ports --https-port "${https_port:-8443}")
[[ "$turn_enabled" != true ]] || args+=(--turn)
bash ./preflight.sh "${args[@]}"

# Only configuration is mounted. No Docker socket, VPN files or credentials are exposed.
docker run --rm --network host --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=$PWD,dst=/config" --workdir /config \
  node:24-bookworm-slim node render-config.mjs --check-dns

docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Build can briefly use CPU/RAM. For a busy VPN server, build this image on a separate
# machine, docker load it here, and use compose up -d --no-build instead.
docker compose -f compose.yaml build app
docker compose -f compose.yaml up -d --no-build
printf '\nContainers started. TLS issuance and real media connectivity still need verification.\n'
docker compose -f compose.yaml ps
printf 'Read the administrator password locally from deploy/.env. Do not paste that file into chat.\n'
