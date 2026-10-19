# Установка без Docker рядом с VPN

Этот путь использует три службы systemd и не устанавливает Docker, не меняет маршрутизацию, NAT, Xray, firewall или пакеты Ubuntu. На проверенном VPS порты 443 и 8443 заняты VPN, поэтому для Signal выбран **9443**. HTTP80 остаётся необходимым для выдачи и продления IP сертификата Let's Encrypt. Приложение и API SFU слушают только 127.0.0.1; медиа используют TCP7881 и UDP7882–7883.

Команды установки выполняет root. Распакуйте комплект в отдельную временную папку, например `/root/signal-bundle`, а не в `/opt/signal`. Комплект должен содержать готовую папку `dist`, сервер и `package-lock.json`. Скрипт откажется использовать неизвестную непустую `/opt/signal`; существующие секреты сохраняются при повторной настройке.

```bash
bash deploy/native/install.sh 13.143.172.92 9443
```

Скрипт проверит порты и память, скачает закреплённые официальные бинарники и проверит checksum перед распаковкой. Node24.19.0 и LiveKit1.13.10 проверяются SHA256, Caddy2.11.7 — SHA512 из официального manifest, дополнительно зафиксирован SHA256 самого архива. Для зависимостей приложения используется `npm ci --omit=dev --ignore-scripts` с lockfile. Lifecycle скрипты зависимостей не запускаются. Системная версия Node не устанавливается и не меняется.

Установка не запускает службы. После успешных проверок включите только их:

```bash
systemctl enable --now signal-media signal-app signal-caddy
systemctl is-active signal-media signal-app signal-caddy
curl --fail http://127.0.0.1:3000/api/health
curl --fail https://13.143.172.92:9443/api/health
```

Ожидаются active у всех трёх служб, `ok: true`, `mediaConfigured: true`, доверенный TLS без исключений браузера. Поле mediaConfigured подтверждает настройки, а не соединение между клиентами. Проверьте голос и видео с двух внешних устройств, затем десять одновременных браузеров и доступность VPN. Веб сервис должен открываться по [https://13.143.172.92:9443](https://13.143.172.92:9443). Выдача и продление сертификата требуют проверки на сервере; сертификат IP действует 160 часов.

```bash
journalctl -u signal-app -u signal-media -u signal-caddy --since '10 minutes ago' --no-pager
ss -ltnup
systemctl show signal-app signal-media signal-caddy -p CPUUsageNSec -p MemoryCurrent -p NRestarts
```

Структура:

| Путь | Содержимое и доступ |
| --- | --- |
| `/opt/signal/app` | Приложение и готовый клиент; root владеет файлами |
| `/opt/signal/runtime` | Приватные Node и бинарники SFU/Caddy |
| `/etc/signal/settings.env` | Все секреты и параметры; root0600 |
| `/etc/signal/app.env` | EnvironmentFile, который читает systemd; root0600 |
| `/etc/signal/livekit.yaml` | root:signal-media0640 |
| `/etc/signal/Caddyfile` | root:signal-caddy0640 |
| `/var/lib/signal` | SQLite; владелец signal,0700 |
| `/var/lib/signal-caddy` | Сертификаты и ACME состояние; signal-caddy,0700 |

Службы работают от разных пользователей `signal`, `signal-media`, `signal-caddy`. Только Caddy получает `CAP_NET_BIND_SERVICE` для TCP80. У всех включены защита системных файлов, отдельная временная папка, запрет повышения привилегий и ограничения ресурсов. CPUQuota задаётся в процентах одного ядра: приложение30%, SFU125%, Caddy15%; память384МБ/1ГБ/128МБ. Это начальный бюджет, не гарантия отсутствия задержек при нагрузке и CPU steal у провайдера.

Первичное имя администратора — `admin`, пароль находится в `/etc/signal/settings.env`. Просматривайте его локально; не отправляйте файл в чат. Первоначальный пароль в env не меняет уже созданную учётную запись в БД. Отредактировать параметры адреса можно в settings.env и затем выполнить:

```bash
/opt/signal/runtime/node-v24.19.0-linux-x64/bin/node /opt/signal/app/deploy/native/configure.mjs --server-ip 13.143.172.92 --check-dns
chown root:signal-media /etc/signal/livekit.yaml
chown root:signal-caddy /etc/signal/Caddyfile
chmod 0640 /etc/signal/livekit.yaml /etc/signal/Caddyfile
```

Renderer сохраняет секреты и создаёт файлы с root0600; поэтому права двух конфигов после рендеринга нужно восстановить командами выше. `/etc/signal` имеет0755, чтобы службы могли пройти к своим файлам, но секретные env остаются root0600. При изменении адреса перезапускаются только службы Signal; активные звонки при этом прервутся. Полезно сначала проверить Caddy через `caddy adapt`, как это делает установщик.

Модерация каналов требует Caddy `forward_auth` на `/rtc` и `/rtc/*`: внутренний Node маршрут `/internal/media-access` проверяет подпись и срок LiveKit JWT, членство, блокировку и запрет публикации в актуальной БД. Сам маршрут `/internal/*` снаружи возвращает404. Это применяется к IP и доменному режимам; HTTP LiveKit7880 остаётся только на loopback. Self-hosted LiveKit не отзывает JWT при удалении участника, поэтому прямой публичный маршрут `/rtc` к LiveKit без этой проверки отключает защиту от повторного входа со старым токеном. Текущий участник удаляется через RoomService; неудавшиеся операции модерации сохраняются в SQLite и повторяются каждые5 секунд. Никнеймы активных участников синхронизируются с БД без отключения звонков.

После резервной копии и успешного `caddy validate` Caddy2.11+ поддерживает `systemctl kill --kill-whom=main --signal=SIGUSR1 signal-caddy`, если запущен через `caddy run` с конфигурационным файлом, без `--resume` и предыдущих изменений через API. Admin API остаётся выключенным. Условия сигнальной перезагрузки описаны в [официальной документации Caddy](https://caddyserver.com/docs/command-line#signals). После изменения маршрутов сначала убедитесь, что обновлённый `signal-app` работает: без него проверка медиадоступа будет отклонять новые подключения.

Согласованная резервная копия:

```bash
bash /opt/signal/app/deploy/native/backup.sh
```

Она ненадолго останавливает только `signal-app`, копирует всю SQLite папку и секретные конфиги, затем возвращает приложению предыдущее состояние. Храните защищённую копию за пределами VPS. Для обновления создайте backup и остановите только три службы Signal; повторный install создаст `app.previous.<UTC>` и сохранит текущую БД и ключи. Не меняйте старые runtime бинарники во время звонка. Старые каталоги не удаляются автоматически.

Официальные источники:

- [Node24.19.0 и файлы выпуска](https://nodejs.org/download/release/v24.19.0/), [SHA256](https://nodejs.org/download/release/v24.19.0/SHASUMS256.txt).
- [LiveKit1.13.10](https://github.com/livekit/livekit/releases/tag/v1.13.10) и его `checksums.txt`.
- [Caddy2.11.7](https://github.com/caddyserver/caddy/releases/tag/v2.11.7) и `caddy_2.11.7_checksums.txt`.
- [Публичные IP сертификаты Let's Encrypt](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability).
