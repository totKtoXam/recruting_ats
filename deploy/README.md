# Deploy на portal.devexpert.kz

Приложение: `https://portal.devexpert.kz/recruiting`.

Схема: nginx (TLS, корпоративный сертификат) → `127.0.0.1:3000` (Node.js, systemd-сервис `recruiting-ats`) → PostgreSQL.
Выкладка — GitHub Actions на self-hosted runner, установленном на этом же сервере: сервер в закрытой сети, GitHub-hosted runner до него не достаёт, а self-hosted runner сам подключается к GitHub исходящим соединением.

| Файл | Назначение |
|---|---|
| `setup.sh` | Первичная подготовка сервера: Node.js 22, пользователи, каталоги, env-файл, systemd-юнит, sudoers, nginx-сниппет. |
| `deploy.sh` | Выкладка релиза с проверкой `/recruiting/healthz` и автооткатом. |
| `recruiting-ats.service` | systemd-юнит. |
| `nginx-recruiting.conf` | `location /recruiting/` для server-блока portal.devexpert.kz. |
| `env.production.example` | Шаблон `/etc/recruiting-ats/env`. |
| `../.github/workflows/deploy.yml` | Deploy после зелёного CI на `main`. |

Каталоги на сервере:

```text
/opt/recruiting-ats/releases/<дата>-<commit>/   релизы (последние 5)
/opt/recruiting-ats/current -> releases/...     активный релиз
/etc/recruiting-ats/env                         переменные окружения (root:recruiting, 640)
```

## 1. PostgreSQL

Приложению нужна своя роль и база. Подключение — напрямую к PostgreSQL, не через Warpgate
(Warpgate — для доступа людей, у сервиса должна быть отдельная учётка):

```sql
CREATE ROLE recruiting LOGIN PASSWORD '<пароль>';
CREATE DATABASE recruiting OWNER recruiting;
```

Если PostgreSQL на этом же сервере — `DATABASE_URL=postgres://recruiting:<пароль>@127.0.0.1:5432/recruiting`.
Если на другом хосте — его адрес во внутренней сети и `DATABASE_SSL=true`, если сервер БД требует TLS.
Миграции применяются самим приложением при каждом старте.

## 2. Подготовка сервера

Ubuntu/Debian, от root:

```bash
git clone https://github.com/totKtoXam/recruting_ats.git /tmp/recruting_ats
cd /tmp/recruting_ats
sudo bash deploy/setup.sh
```

Скрипт создаёт системного пользователя `recruiting` (под ним работает сервис) и `github-runner` (под ним работает runner), генерирует `SESSION_SECRET` и `ATS_API_KEY`.

Заполнить `/etc/recruiting-ats/env`: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_ALLOWED_DOMAINS`/`AUTH_ALLOWED_EMAILS`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `GOOGLE_DRIVE_REFRESH_TOKEN`.
`GOOGLE_DRIVE_REFRESH_TOKEN` удобнее получить на своём компьютере (`npm run drive:auth`) и перенести на сервер.

## 3. nginx

В существующий server-блок `portal.devexpert.kz` (`listen 443 ssl` с корпоративным сертификатом):

```nginx
include snippets/recruiting-ats.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Если TLS терминируется не на этом nginx, а раньше (другой прокси), в сниппете замените `X-Forwarded-Proto $scheme` на `https`.

## 4. Google Cloud Console

В OAuth-клиенте добавить Authorized redirect URI:

```text
https://portal.devexpert.kz/recruiting/auth/google/callback
```

Серверу нужен исходящий доступ к `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `www.googleapis.com`.

## 5. GitHub Actions runner

GitHub → репозиторий → Settings → Actions → Runners → New self-hosted runner → Linux x64. На сервере:

```bash
sudo -iu github-runner
mkdir actions-runner && cd actions-runner
# curl -o ... и tar xzf ... — команды со страницы GitHub
./config.sh --url https://github.com/totKtoXam/recruting_ats --token <token> \
  --labels recruiting-ats --name portal --unattended
exit
cd /home/github-runner/actions-runner
sudo ./svc.sh install github-runner
sudo ./svc.sh start
```

Репозиторий публичный, поэтому обязательно:
Settings → Actions → General → Fork pull request workflows from outside collaborators → **Require approval for all external contributors**.
Иначе PR из форка может изменить workflow и выполнить код на сервере. Надёжнее — сделать репозиторий приватным.

## 6. Первый релиз и дальнейшие

Actions → Deploy → Run workflow (ветка `main`). Дальше deploy запускается автоматически после зелёного CI на каждый push в `main`.

`deploy.sh` копирует код в новый релиз, выполняет `npm ci --omit=dev`, переключает `current`, перезапускает сервис и до минуты ждёт `/recruiting/healthz`. Если приложение не поднялось — выводит журнал сервиса, возвращает предыдущий релиз и завершает job с ошибкой. Миграции БД при откате не отменяются.

Вручную на сервере (из checkout репозитория):

```bash
sudo -u github-runner bash deploy/deploy.sh
```

## Эксплуатация

```bash
systemctl status recruiting-ats
journalctl -u recruiting-ats -f
curl -s http://127.0.0.1:3000/recruiting/healthz
ls -l /opt/recruiting-ats/current
```

Откат на конкретный релиз:

```bash
sudo -u github-runner ln -sfn /opt/recruiting-ats/releases/<релиз> /opt/recruiting-ats/current
sudo systemctl restart recruiting-ats
```

Резервные копии БД — например, ежедневный `pg_dump` по cron:

```cron
15 3 * * * pg_dump -Fc "postgres://recruiting:<пароль>@127.0.0.1:5432/recruiting" > /var/backups/recruiting-$(date +\%F).dump
```
