#!/usr/bin/env bash
# Stops only this app for a consistent SQLite database copy, then restores its prior state.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
container_id="$(docker compose -f compose.yaml ps -aq app)"
[[ -n "$container_id" ]] || { printf 'No application container exists.\n' >&2; exit 1; }
was_running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
resume_app() { [[ "$was_running" != true ]] || docker compose -f compose.yaml start app >/dev/null; }
trap resume_app EXIT
[[ "$was_running" != true ]] || docker compose -f compose.yaml stop app
destination="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 -p -- "$destination"
docker cp "$container_id:/data/." "$destination/"
chmod -R go-rwx -- "$destination"
printf 'Consistent application database copy: deploy/%s\n' "$destination"
printf 'Store deploy/.env separately in an encrypted backup. TLS data remains in Docker volumes.\n'
