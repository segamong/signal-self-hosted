#!/usr/bin/env bash
# Read-only inspection: no package installs, service changes, firewall changes or speed tests.
set -euo pipefail
export LC_ALL=C

https_port=8443
turn=false
check_ports=false
while (($#)); do
  case "$1" in
    --check-ports) check_ports=true; shift ;;
    --https-port) https_port="${2:?missing port}"; shift 2 ;;
    --turn) turn=true; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$https_port" =~ ^[0-9]+$ ]] && ((https_port >= 1024 && https_port <= 65535)) || { printf 'Invalid HTTPS port\n' >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { printf 'This deployment requires a Linux server.\n' >&2; exit 1; }
for binary in awk ss df free ps; do
  command -v "$binary" >/dev/null || { printf 'Missing command: %s\n' "$binary" >&2; exit 1; }
done

printf '\nOS and CPU\n'
awk -F= '/^(PRETTY_NAME|VERSION_ID)=/ { print }' /etc/os-release
printf 'Logical CPUs: %s\n' "$(getconf _NPROCESSORS_ONLN)"
if command -v lscpu >/dev/null; then lscpu | awk -F: '/^(Model name|CPU MHz|Hypervisor vendor|Virtualization type):/ { print }'; fi
uptime
printf '\nMemory\n'
free -h
printf '\nDisk at deployment location\n'
df -h -- .
df -i -- .
printf '\nVPN processes (names and resource counters only)\n'
ps -eo comm,pid,pcpu,pmem --sort=-pcpu | awk 'NR == 1 || tolower($1) ~ /(xray|sing-box|openvpn|wireguard|wg-quick|x-ui|3x-ui)/ {print}'
printf '\nListening sockets (no configuration files or command arguments)\n'
ss -H -ltnup
printf '\nConnections\n'
ss -s
printf '\nNetwork counters since boot (not a bandwidth measurement)\n'
cat /proc/net/dev
if command -v vmstat >/dev/null; then
  printf '\nOne-second CPU sample; first row is since boot, second is current\n'
  vmstat 1 2
fi
if [[ -r /proc/pressure/cpu ]]; then
  printf '\nCPU and memory pressure\n'
  cat /proc/pressure/cpu /proc/pressure/memory
fi
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  printf '\nDocker containers: CPU / memory / network\n'
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}'
fi

if [[ "$check_ports" == true ]]; then
  conflict=false
  check_socket() {
    local protocol="$1" port="$2" rows
    if [[ "$protocol" == tcp ]]; then rows="$(ss -H -ltn "sport = :$port")";
    else rows="$(ss -H -lun "sport = :$port")"; fi
    if [[ -n "$rows" ]]; then
      printf 'CONFLICT %s/%s already occupied:\n%s\n' "$port" "$protocol" "$rows" >&2
      conflict=true
    fi
  }
  for port in 80 "$https_port" 3000 7880 7881; do check_socket tcp "$port"; done
  for port in 7882 7883; do check_socket udp "$port"; done
  if [[ "$turn" == true ]]; then
    check_socket udp 3478
    for ((port=30000; port<=30100; port++)); do check_socket udp "$port"; done
  fi
  if [[ "$conflict" == true ]]; then
    printf '\nDeployment stopped: port conflict. Existing services have not been changed.\n' >&2
    exit 1
  fi
  available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  disk_kib="$(df -Pk -- . | awk 'NR == 2 {print $4}')"
  ((available_kib >= 1800000)) || { printf 'Less than 1.8 GiB available RAM. Review VPN peak load before deploying.\n' >&2; exit 1; }
  ((disk_kib >= 6 * 1024 * 1024)) || { printf 'Less than 6 GiB free disk for images, build and data.\n' >&2; exit 1; }
  printf '\nLocal ports and minimum resource headroom pass. WAN capacity and peak VPN load are not measured.\n'
fi
