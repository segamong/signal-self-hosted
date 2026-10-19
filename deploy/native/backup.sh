#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" == 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
[[ -f /opt/signal/.signal-managed ]] || { printf 'Unknown installation.\n' >&2; exit 1; }
was_running=false
systemctl is-active --quiet signal-app && was_running=true
resume() { [[ "$was_running" != true ]] || systemctl start signal-app; }
trap resume EXIT
[[ "$was_running" != true ]] || systemctl stop signal-app
destination="/opt/signal/backups/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$destination"
tar -C /var/lib/signal -czf "$destination/data.tar.gz" .
tar -C /etc -czf "$destination/config-secret.tar.gz" signal
chmod 0600 "$destination/data.tar.gz" "$destination/config-secret.tar.gz"
printf 'Backup ready in %s. config-secret.tar.gz includes secrets; encrypt before off-server storage.\n' "$destination"
