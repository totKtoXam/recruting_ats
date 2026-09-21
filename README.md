# Recruiting ATS

Лёгкая ATS (Applicant Tracking System) на Node.js.

Данные хранятся в PostgreSQL, файлы кандидатов — в Google Drive (как и в прежней версии на Apps Script), пользователи входят через Google.

> Раньше проект работал на Google Apps Script (Google Sheets + Google Drive + clasp). Бэкенд полностью заменён на Node.js 22 + Express 5 + PostgreSQL; резюме по-прежнему лежат в Google Drive с той же структурой папок. Фронтенд и формат RPC сохранены, поэтому интерфейс не изменился. Перенос данных из старой таблицы описан в разделе [Миграция из Google Sheets](#миграция-из-google-sheets).

## Возможности

- Kanban по этапам найма с drag & drop, фильтрами и сворачиваемыми колонками.
- Вход через Google OAuth; пользователь идентифицируется по OpenID Connect `sub`.
- Таблица пользователей с автоматическим созданием записи при первом входе и управлением доступом (allowlist email/доменов).
- Админ-панель: CRUD вакансий, источников, ответственных и шаблонов интервью.
- Ответственные ограничиваются доступными этапами найма.
- Карточка кандидата с обязательными ФИО, вакансией, телефоном, рекрутером, ответственным HR, ответственным тех. интервьювером и резюме.
- ФЛК мобильного номера Казахстана и email.
- Telegram username автоматически преобразуется в кликабельную ссылку.
- Загрузка PDF/DOC/DOCX резюме (до 10 МБ) в папку кандидата в Google Drive; все версии резюме доступны на странице файлов кандидата, пользователям ATS не нужен собственный доступ к Drive.
- Произвольные дополнительные ссылки кандидата.
- Управляемый pipeline: Новый ↔ HR screening ↔ Техническое интервью ↔ Финальное интервью ↔ Offer ↔ Hired.
- При каждом переходе между этапами запрашивается результат этапа/интервью.
- Для обязательного шаблона переход блокируется, пока не заполнены все его вопросы; проверка выполняется и на сервере.
- Каждый переход статуса пишется в append-only таблицу `candidate_status_log` с пользователем, выполнившим переход (UPDATE/DELETE запрещены триггером).
- Шаблон вопросов автоматически подбирается по вакансии и текущему этапу.
- История результатов интервью доступна для просмотра и редактирования.
- Архивирование сохраняет текущий статус кандидата и проставляет `archived_at`.
- Resume Intake API для AI-интеграций: создание предзаполненных черновиков кандидатов (см. [`docs/API.md`](docs/API.md)).
- Автоматические миграции схемы БД при старте.
- CI в GitHub Actions: тесты, проверка миграций на чистом PostgreSQL, сборка Docker-образа.

## Архитектура

```text
Browser (web/Index.html + Scripts.html)
  |
  |  GET /                 — страница приложения (нужна сессия)
  |  POST /api/rpc/:name   — RPC-методы (JSON, cookie ats.sid)
  |  GET /files/:id        — выдача файла из Google Drive через сервер
  |  /auth/*               — вход через Google / выход
  v
Node.js 22 + Express 5  (server/)
  |-- pg ---------------------> PostgreSQL
  |                               данные ATS + сессии (таблица session)
  |-- @googleapis/drive ------> Google Drive API (папка «Кандидаты»)
  |                               резюме кандидатов и черновиков
  |-- fetch ------------------> Google OAuth 2.0 / OpenID Connect
  ^
  |  GET/POST /intake?api=...  (API key, без сессии)
  |
AI-ассистент / Skill (skills/recruiting-ats-resume)

GitHub --> GitHub Actions (ci.yml)
             npm test
             миграции на postgres:17
             docker build
```

Сервер состоит из одного процесса: HTML, RPC, выдача файлов и Resume Intake API обслуживаются одним Express-приложением.

### Работа фронтенда

Стартовая загрузка ATS использует один RPC `getBootstrapData`. В bootstrap входят:

- текущий пользователь;
- вакансии, источники, ответственные, шаблоны и справочники;
- лёгкие карточки активных кандидатов;
- статистика.

Не загружаются при старте:

- архив кандидатов — загружается при включении фильтра «Архив»;
- история интервью — загружается при открытии конкретного кандидата;
- полный объект кандидата с историей резюме и дополнительными ссылками — загружается при открытии карточки;
- список пользователей для привязки ответственных — загружается при открытии админ-панели.

Запись «Последний вход» пользователя обновляется не чаще раза в 30 минут.

### Pipeline кандидата

```text
Новый
  ↕
HR screening
  ↕
Техническое интервью
  ↕
Финальное интервью
  ↕
Offer
  ↕
Hired
```

Переход в архив доступен отдельно из любого активного этапа. Текущий статус кандидата сохраняется, запись остаётся в таблице `candidates` с заполненным `archived_at`.

## Требования

- Node.js 22+ и npm.
- PostgreSQL 14+ (в разработке и CI используется 17).
- Docker и Docker Compose — для локальной разработки и деплоя (рекомендуется).
- Google Cloud проект с OAuth client — для входа через Google и доступа к Google Drive (включённый Google Drive API).
- Папка в Google Drive для резюме (обычного бесплатного Gmail достаточно) — см. [Настройка Google Drive](#настройка-google-drive).

## Быстрый старт (локально)

```bash
cp .env.example .env
```

Сгенерируй `SESSION_SECRET` и впиши его в `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Подними PostgreSQL:

```bash
docker compose up -d postgres
```

Настрой доступ к Google Drive и впиши `GOOGLE_DRIVE_ROOT_FOLDER_ID` и `GOOGLE_DRIVE_REFRESH_TOKEN` в `.env` — см. [Настройка Google Drive](#настройка-google-drive). Без этого сервер не стартует.

Установи зависимости и запусти сервер в режиме разработки:

```bash
npm install
npm run dev
```

Открой http://localhost:3000.

В `.env.example` по умолчанию стоит `AUTH_MODE=dev` — вход по email без пароля. Пока allowlist не задан, доступ автоматически получает только первый вошедший пользователь. Для проверки входа через Google см. [Настройка Google OAuth](#настройка-google-oauth).

При старте сервер сам:

- накатывает миграции БД (под advisory lock, поэтому безопасно при нескольких инстансах);
- проверяет доступ к корневой папке Google Drive (`GOOGLE_DRIVE_ROOT_FOLDER_ID`) и при ошибке сразу завершается с понятным сообщением.

### Полный стек в Docker

```bash
docker compose --profile app up --build
```

В `docker-compose.yml` только PostgreSQL и приложение (профиль `app`). Контейнер `app` берёт переменные из `.env`, а `DATABASE_URL` переопределяет на адрес PostgreSQL внутри compose-сети. Файлы хранятся в Google Drive, отдельное хранилище поднимать не нужно.

### Тесты

```bash
npm test
```

Unit-тесты на `node:test` лежат в `test/`.

## Переменные окружения

Все переменные перечислены в `.env.example`.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `NODE_ENV` | `development` | `production` включает secure cookie, кэш шаблона и проверку конфигурации при старте. |
| `PORT` | `3000` | Порт HTTP-сервера. |
| `PUBLIC_URL` | `http://localhost:3000` | Публичный URL приложения без завершающего `/`. Используется в OAuth redirect URI и ссылках черновиков. |
| `APP_TIMEZONE` | `Asia/Almaty` | Часовой пояс для отображения дат. |
| `TRUST_PROXY` | `false` | `true`, если приложение стоит за reverse proxy / load balancer с HTTPS. |
| `DATABASE_URL` | `postgres://ats:ats@localhost:5432/ats` | Строка подключения к PostgreSQL. |
| `DATABASE_SSL` | `false` | `true` — подключаться к PostgreSQL по TLS. |
| `SESSION_SECRET` | — | Секрет подписи cookie сессии. В production обязателен, не короче 32 символов. |
| `SESSION_MAX_AGE_DAYS` | `14` | Время жизни сессии в днях (продлевается при активности). |
| `AUTH_MODE` | `google` | `google` — вход через Google OAuth; `dev` — вход по email без пароля (только для локальной разработки, в production запрещён). |
| `GOOGLE_CLIENT_ID` | — | Client ID OAuth-клиента Google. Обязателен при `AUTH_MODE=google` в production. |
| `GOOGLE_CLIENT_SECRET` | — | Client secret OAuth-клиента Google. |
| `AUTH_ALLOWED_DOMAINS` | — | Домены email через запятую, пользователям которых доступ выдаётся автоматически. |
| `AUTH_ALLOWED_EMAILS` | — | Email через запятую, которым доступ выдаётся автоматически. |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | — | Обязательна. ID папки «Кандидаты» в Google Drive (`https://drive.google.com/drive/folders/<ID>`). В ней создаются папки кандидатов и папка черновиков. |
| `GOOGLE_DRIVE_AUTH` | `oauth` | Способ доступа к Drive: `oauth` — от имени Google-аккаунта-владельца папки (подходит обычный Gmail); `service_account` — сервисный аккаунт, только с общим диском (Shared Drive) Google Workspace. |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | — | Для `oauth`: refresh token аккаунта-владельца папки. Получается командой `npm run drive:auth`. |
| `GOOGLE_DRIVE_CLIENT_ID` | `GOOGLE_CLIENT_ID` | Необязательно: отдельный OAuth-клиент для Drive. |
| `GOOGLE_DRIVE_CLIENT_SECRET` | `GOOGLE_CLIENT_SECRET` | Необязательно: секрет отдельного OAuth-клиента для Drive. |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` | — | Для `service_account`: JSON-ключ сервисного аккаунта одной строкой. Альтернатива — путь к файлу ключа в `GOOGLE_APPLICATION_CREDENTIALS`. |
| `ATS_API_KEY` | — | Ключ Resume Intake API. Пока не задан, `/intake` отвечает `503`. |

Есть ещё `GOOGLE_DRIVE_API_URL` — адрес эмулятора Drive API только для тестов; в production сервер с ней не стартует.

Сгенерировать `ATS_API_KEY`:

```bash
node -e "console.log('ats_'+require('crypto').randomBytes(24).toString('hex'))"
```

## Настройка Google OAuth

1. Открой [Google Cloud Console](https://console.cloud.google.com/) и выбери или создай проект.
2. `APIs & Services -> OAuth consent screen` — настрой экран согласия. Для корпоративного Google Workspace удобно выбрать тип `Internal`: тогда войти смогут только аккаунты домена.
3. `APIs & Services -> Credentials -> Create credentials -> OAuth client ID`.
4. Тип приложения — **Web application**.
5. В `Authorized redirect URIs` добавь:

   ```text
   <PUBLIC_URL>/auth/google/callback
   ```

   Например, `https://ats.example.com/auth/google/callback`, а для локальной проверки — `http://localhost:3000/auth/google/callback`.

6. Скопируй Client ID и Client secret в `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`, установи `AUTH_MODE=google`.

Приложение запрашивает только scope `openid email profile`. Вход с неподтверждённым email Google отклоняется.

> `PUBLIC_URL` должен в точности совпадать с адресом, по которому пользователи открывают ATS, иначе Google вернёт `redirect_uri_mismatch`.

## Настройка Google Drive

Резюме хранятся в Google Drive. Приложение работает с Drive от имени одного аккаунта (режим `oauth`) или сервисного аккаунта (режим `service_account`) и отдаёт файлы пользователям через себя — самим пользователям ATS доступ к папке в Drive не нужен.

### Режим `oauth` (по умолчанию)

Приложение действует от имени одного Google-аккаунта — так же, как Apps Script с «Execute as: Me». Подходит обычный бесплатный Gmail; файлы занимают квоту этого аккаунта (15 ГБ у бесплатного).

1. Создай в Drive этого аккаунта папку «Кандидаты» (или используй старую, см. [Миграция из Google Sheets](#миграция-из-google-sheets)) и скопируй её ID из адреса `https://drive.google.com/drive/folders/<ID>` в `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
2. В том же Google Cloud проекте включи **Google Drive API**: `APIs & Services -> Library -> Google Drive API -> Enable`.
3. В OAuth-клиенте из [Настройки Google OAuth](#настройка-google-oauth) добавь в `Authorized redirect URIs`:

   ```text
   http://localhost:53682/oauth2callback
   ```

   Отдельный OAuth-клиент для Drive не обязателен: по умолчанию берутся `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (их можно переопределить через `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET`).
4. Запусти:

   ```bash
   npm run drive:auth
   ```

   Открой выведенную ссылку, войди аккаунтом-владельцем папки и разреши доступ.
5. Скопируй выведенный refresh token в `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_AUTH=oauth`.

Запрашивается scope `https://www.googleapis.com/auth/drive`.

> **Важно.** Если экран согласия OAuth в статусе публикации **Testing**, refresh token истекает через 7 дней, и загрузка резюме перестанет работать. Переведи экран согласия в **In production** (`APIs & Services -> OAuth consent screen -> Publish app`). Для личного/внутреннего использования верификация приложения не нужна: неверифицированное приложение работает, пользователь один раз видит экран-предупреждение. В Google Workspace можно вместо этого выбрать тип `Internal`.

### Режим `service_account`

Работает **только с общим диском (Shared Drive) Google Workspace**: у сервисного аккаунта нет собственной квоты хранилища, поэтому в обычный «Мой диск» он загружать файлы не может.

1. Создай сервисный аккаунт в Google Cloud, включи Google Drive API и выпусти JSON-ключ.
2. Добавь email сервисного аккаунта участником общего диска с ролью **Content manager** («Менеджер контента»).
3. Создай на общем диске папку «Кандидаты» и укажи её ID в `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
4. Установи `GOOGLE_DRIVE_AUTH=service_account` и передай ключ в `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` (JSON одной строкой) или путь к файлу ключа в `GOOGLE_APPLICATION_CREDENTIALS`.

### Проверка при старте

При старте сервер проверяет, что `GOOGLE_DRIVE_ROOT_FOLDER_ID` задан, указывает на папку не в корзине и доступен аккаунту приложения. Иначе сервер не запускается и пишет в лог причину (например, «Папка GOOGLE_DRIVE_ROOT_FOLDER_ID не найдена или у аккаунта приложения нет к ней доступа»).

## Управление доступом

Ролей нет: все пользователи с доступом имеют одинаковые права, включая админ-панель.

Правила при входе:

1. Если задан allowlist (`AUTH_ALLOWED_EMAILS` и/или `AUTH_ALLOWED_DOMAINS`), новый пользователь получает доступ только при совпадении email или домена — в том числе самый первый.
2. Без allowlist доступ получает только самый первый вошедший пользователь (удобно для локальной разработки). В `NODE_ENV=production` сервер без allowlist не стартует.
3. Иначе в таблице `users` создаётся запись с `is_active = false`, а вход отклоняется с сообщением «Доступ … не выдан или отключён».

Выдать доступ пользователю, который уже пытался войти:

```sql
UPDATE users SET is_active = true WHERE lower(email) = 'user@example.com';
```

Отключить пользователя:

```sql
UPDATE users SET is_active = false WHERE lower(email) = 'user@example.com';
```

Отключённый пользователь разлогинивается при следующем запросе — сессия проверяется на каждом запросе.

Подключиться к БД в локальном compose:

```bash
docker compose exec postgres psql -U ats -d ats
```

## Deploy

### Render (бесплатно)

В репозитории есть Blueprint [`render.yaml`](render.yaml): Node-сервис на бесплатном тарифе Render, деплой при каждом push в `main`. Бесплатный сервис засыпает через ~15 минут без запросов, и первое открытие после сна занимает 30–60 секунд.

1. **PostgreSQL** — создай бесплатную базу на [Neon](https://neon.tech) (регион Frankfurt, ближе к Render) и скопируй connection string вида `postgres://…neon.tech/…?sslmode=require`. Бесплатная база самого Render удаляется через 30 дней, поэтому она не подходит.
2. **Сервис** — Render → **New → Blueprint** → выбери этот репозиторий. Render создаст сервис `recruiting-ats`; `SESSION_SECRET` и `ATS_API_KEY` сгенерируются автоматически.
3. **Переменные** (Render спросит их при создании, позже — Service → Environment):
   - `PUBLIC_URL` — `https://recruiting-ats.onrender.com` (точный адрес виден в дашборде);
   - `DATABASE_URL` — строка подключения Neon;
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — см. [Настройка Google OAuth](#настройка-google-oauth);
   - `AUTH_ALLOWED_DOMAINS` и/или `AUTH_ALLOWED_EMAILS` — без них сервер в production не стартует;
   - `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `GOOGLE_DRIVE_REFRESH_TOKEN` — см. [Настройка Google Drive](#настройка-google-drive) (`npm run drive:auth` выполняется один раз локально).
4. **Google Cloud** — в OAuth-клиенте добавь Authorized redirect URI `https://<адрес>.onrender.com/auth/google/callback`.
5. Схема БД создаётся автоматически при первом старте. Если нужно перенести данные из старой таблицы, выполни импорт локально, указав `DATABASE_URL` базы Neon (см. [Миграция из Google Sheets](#миграция-из-google-sheets)).

### Docker-образ

`Dockerfile` собирает production-образ на `node:22-alpine`: только production-зависимости, запуск от пользователя `node`, порт `3000`, healthcheck на `GET /healthz`.

```bash
docker build -t recruiting-ats .
docker run -d --name recruiting-ats \
  --env-file .env.production \
  -p 3000:3000 \
  recruiting-ats
```

Минимальный набор переменных для production:

```dotenv
NODE_ENV=production
PUBLIC_URL=https://ats.example.com
TRUST_PROXY=true
DATABASE_URL=postgres://...
SESSION_SECRET=<не короче 32 символов>
AUTH_MODE=google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
AUTH_ALLOWED_DOMAINS=example.com
GOOGLE_DRIVE_ROOT_FOLDER_ID=...
GOOGLE_DRIVE_AUTH=oauth
GOOGLE_DRIVE_REFRESH_TOKEN=...
ATS_API_KEY=...
```

При `NODE_ENV=production` сервер не стартует, если `SESSION_SECRET` короче 32 символов, включён `AUTH_MODE=dev` или не заданы `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, пуст allowlist (`AUTH_ALLOWED_DOMAINS` / `AUTH_ALLOWED_EMAILS`) или задан тестовый `GOOGLE_DRIVE_API_URL`. В любом окружении сервер не стартует без доступа к папке Google Drive.

Для хранения файлов отдельное объектное хранилище не нужно: достаточно PostgreSQL и Google Drive, что упрощает бесплатный или дешёвый хостинг.

Миграции применяются автоматически при старте контейнера. Их можно запустить и отдельно:

```bash
npm run migrate
```

`GET /healthz` возвращает `{"ok":true}`, если приложение доступно и отвечает БД, иначе `503`.

### Reverse proxy и HTTPS

В production приложение должно работать только по HTTPS: cookie сессии `ats.sid` выставляется с флагом `Secure`.

Обычно TLS терминируется на reverse proxy (nginx, Caddy, Traefik, облачный load balancer). В этом случае:

- установи `TRUST_PROXY=true` — Express будет доверять `X-Forwarded-Proto` от первого прокси; без этого secure cookie не выставится и вход будет «зацикливаться»;
- прокси должен передавать заголовки `Host` и `X-Forwarded-Proto`;
- лимит тела запроса на прокси — не меньше 20 МБ (резюме передаются в base64 внутри JSON).

Пример для nginx:

```nginx
server {
    listen 443 ssl;
    server_name ats.example.com;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Не публикуй порт `3000` напрямую в интернет — только через прокси.

### Очистка черновиков

Сервер сам удаляет использованные и просроченные черновики Resume Intake API: через минуту после старта и далее раз в сутки (файлы переносятся в корзину Google Drive, а не удаляются безвозвратно). Отдельный cron не нужен — это важно для бесплатных хостингов, где его нет, а сервер засыпает.

Запустить очистку вручную:

```bash
npm run cleanup-drafts
```

## Миграция из Google Sheets

Скрипт `scripts/import-from-xlsx.js` переносит данные из прежней Google-таблицы Recruiting ATS в PostgreSQL.

1. Настрой Google Drive (см. [Настройка Google Drive](#настройка-google-drive)): укажи старую папку «Кандидаты» в `GOOGLE_DRIVE_ROOT_FOLDER_ID` и выполни `npm run drive:auth` аккаунтом, которому она принадлежит, — тогда у приложения будет доступ ко всем импортированным резюме.
2. В Google Sheets: `Файл -> Скачать -> Microsoft Excel (.xlsx)`.
3. Накати схему на **пустую** базу:

   ```bash
   npm run migrate
   ```

4. Запусти импорт:

   ```bash
   npm run import:sheets -- ./recruiting-ats.xlsx
   ```

Особенности:

- импорт выполняется только в пустую базу (без кандидатов) и одной транзакцией: при любой ошибке ничего не записывается;
- переносятся листы `Пользователи`, `Вакансии`, `Источники`, `Ответственные`, `Шаблоны интервью`, `Кандидаты`, `Архив кандидатов`, `Интервью`, `Candidate Transition Status Log`, `Справочники`; отсутствующие листы пропускаются с предупреждением;
- исходные ID и номера (`№`) сохраняются (невалидные и дубли заменяются новыми), последовательности синхронизируются;
- файлы **не копируются**: резюме и папки кандидатов уже лежат в Google Drive, импортируются их Drive ID — ID файлов резюме (из `id` в «Версиях резюме», `Resume File ID` или URL) в `files.drive_file_id` и ID папок (из URL «Папки кандидата») в `candidates.drive_folder_id`. Поэтому старые резюме продолжают открываться через ATS, а новые резюме импортированных кандидатов попадают в их существующие папки;
- записи без Drive ID сохраняются как внешние ссылки (`files.external_url`);
- для старых записей без обязательных связей создаются удалённые (soft-deleted) заглушки: ответственный «Импорт Не назначен» и вакансия «Без вакансии (импорт)».

> Выгрузка `.xlsx` содержит персональные данные кандидатов. Не коммить её и удали после импорта.

## Схема БД

Схема описана в `server/db/migrations/001_init.sql`. Применённые миграции учитываются в таблице `schema_migrations`.

| Таблица | Назначение |
|---|---|
| `users` | Пользователи ATS: Google `sub`, email, ФИО, аватар, `is_active`, последний вход. |
| `vacancies` | Вакансии со статусом `Открыта` / `На паузе` / `Закрыта`. |
| `sources` | Источники кандидатов. Название уникально среди неудалённых. |
| `responsibles` | Ответственные (рекрутеры, HR, интервьюеры): доступные этапы `stages`, необязательная привязка к `users`. Один пользователь — не более одного ответственного. |
| `interview_templates` | Шаблоны вопросов по паре вакансия + этап. Не более одного обязательного шаблона на пару. |
| `files` | Метаданные файлов: ID файла в Google Drive (`drive_file_id`) или внешняя ссылка (`external_url`) для импортированных резюме без Drive ID. |
| `candidates` | Кандидаты: контакты, вакансия, статус, назначения, ссылки, комментарий, папка в Google Drive (`drive_folder_id`). Архив — поле `archived_at`. |
| `candidate_resumes` | Версии резюме кандидата (связь `candidates` ↔ `files`). |
| `interviews` | Результаты интервью/этапов: ответы на вопросы шаблона, итог, комментарий. |
| `candidate_status_log` | Append-only журнал переходов статусов. UPDATE и DELETE запрещены триггером. |
| `candidate_drafts` | Черновики кандидатов из Resume Intake API: токен, данные, резюме, срок действия (7 дней). |
| `dictionaries` | Справочники (статусы кандидата, статусы вакансии и т.п.). |
| `session` | Сессии пользователей (connect-pg-simple). |
| `schema_migrations` | Учёт применённых миграций. |

Общие принципы:

- первичные ключи — UUID; человекочитаемые номера `№` берутся из identity-последовательностей;
- справочные сущности удаляются мягко (`deleted_at`), чтобы не ломать историю;
- новые миграции добавляются файлами `server/db/migrations/NNN_*.sql` и применяются по порядку имени.

### Файлы в Google Drive

Структура та же, что в прежней версии на Apps Script:

```text
<GOOGLE_DRIVE_ROOT_FOLDER_ID> («Кандидаты»)
  <ФИО> - <первые 8 hex ID кандидата, в верхнем регистре>/
    yyyy-MM-dd-HH-mm-ss - <исходное имя файла>
  _ATS_Черновики/
    <первые 8 символов токена> - <имя файла>
```

- Папка кандидата создаётся при первой загрузке резюме; если её удалили или переместили в корзину, она создаётся заново.
- Резюме черновика из Resume Intake API лежит в `_ATS_Черновики` и копируется в папку кандидата при сохранении кандидата.
- Если сохранение не удалось, файлы и папки, созданные этим запросом, переносятся в корзину Drive.
- `npm run cleanup-drafts` переносит файлы черновиков в корзину Drive (не удаляет безвозвратно).

Ссылка `/files/:id` доступна только авторизованным пользователям: сервер читает файл из Drive и отдаёт его потоком, поэтому пользователям ATS не нужны собственные права в Drive. PDF открывается в браузере, DOC/DOCX скачиваются. Нативные документы Google (Docs и т.п.) открываются редиректом на их `webViewLink`.

«Папка кандидата» — страница `/candidates/:id/files` со всеми версиями резюме и ссылкой «Открыть папку в Google Drive» (для неё уже нужен доступ к папке в Drive).

## Resume Intake API

Для интеграции с AI/ChatGPT сервер предоставляет `/intake`: получение справочников и создание предзаполненных черновиков кандидатов. API не создаёт кандидата без подтверждения пользователя: он возвращает ссылку `PUBLIC_URL/?draft=<token>`, по которой открывается заполненная форма.

- Документация: [`docs/API.md`](docs/API.md)
- Skill: `skills/recruiting-ats-resume/SKILL.md`
- OpenAPI: `skills/recruiting-ats-resume/openapi.yaml` (замени `servers.url` на свой `PUBLIC_URL`)

## Структура проекта

```text
server/
  index.js            точка входа: проверка конфигурации, миграции, доступ к Drive, запуск HTTP
  app.js              Express-приложение: сессии, RPC, сборка Index.html, healthz
  config.js           конфигурация из env и бизнес-константы (статусы, переходы, лимиты)
  rpc.js              реестр RPC-методов для фронтенда
  db/
    pool.js           пул pg и хелперы транзакций
    migrate.js        раннер миграций (npm run migrate)
    migrations/       SQL-миграции
  lib/                даты, ошибки, клиент Google Drive, валидация
  routes/
    auth.js           вход через Google / dev, выход, проверка сессии
    files.js          /files/:id и /candidates/:id/files
    intake.js         Resume Intake API (/intake)
    html.js           экранирование HTML/JS
  services/           бизнес-логика: кандидаты, интервью, справочники, черновики, файлы, пользователи
web/
  Index.html          основная страница (include-директивы собираются на сервере)
  Styles.html
  Scripts.html        фронтенд, вызывает POST /api/rpc/:name
  AdminView.html
  AdminScripts.html
scripts/
  import-from-xlsx.js перенос данных из Google Sheets
  cleanup-drafts.js   очистка черновиков
  drive-auth.js       получение refresh token для Google Drive (npm run drive:auth)
skills/
  recruiting-ats-resume/  Skill и OpenAPI для AI-ассистента
test/                 unit-тесты (node:test)
docs/API.md           документация Resume Intake API и RPC
Dockerfile
docker-compose.yml    postgres и app (профиль app)
.github/workflows/ci.yml
```

## npm-скрипты

| Команда | Описание |
|---|---|
| `npm start` | Запуск сервера (production; переменные берутся из окружения). |
| `npm run dev` | Запуск с `--watch` и загрузкой `.env`. |
| `npm run migrate` | Применить миграции БД. |
| `npm run cleanup-drafts` | Удалить использованные и просроченные черновики, их файлы перенести в корзину Google Drive. |
| `npm run drive:auth` | Получить `GOOGLE_DRIVE_REFRESH_TOKEN` для режима `oauth`. |
| `npm run import:sheets -- <file.xlsx>` | Импорт данных из выгрузки Google Sheets. |
| `npm test` | Unit-тесты. |

## CI

Workflow `.github/workflows/ci.yml` запускается на push и pull request в `main`:

1. `npm ci` + `npm test` на Node.js 22;
2. применение миграций к чистому PostgreSQL 17 (service container);
3. сборка Docker-образа (без публикации).

Автоматический deploy не настроен: выкладка образа зависит от выбранной инфраструктуры.

## Безопасность

В GitHub не должны попадать:

- `.env` и любые файлы с секретами (`SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` и файлы ключей сервисного аккаунта, `ATS_API_KEY`, пароли БД);
- выгрузки `.xlsx` из Google Sheets и любые другие персональные данные кандидатов.

Что сделано в приложении:

- все страницы, RPC и файлы доступны только после входа; сессия хранится в PostgreSQL, cookie `ats.sid` — `HttpOnly`, `SameSite=Lax`, `Secure` в production;
- RPC принимает только `application/json`, поэтому простые кросс-сайтовые формы не пройдут без CORS preflight;
- OAuth защищён параметром `state`, после входа сессия пересоздаётся; редирект после входа — только на относительные пути приложения;
- файлы из Google Drive отдаются только авторизованным пользователям через сервер; публичные ссылки на файлы в Drive не создаются;
- формат (PDF/DOC/DOCX) и размер (до 10 МБ) резюме проверяются на сервере;
- API key Resume Intake API сравнивается за постоянное время;
- `AUTH_MODE=dev` запрещён в production.

Рекомендации:

- ограничивай доступ через `AUTH_ALLOWED_DOMAINS` / `AUTH_ALLOWED_EMAILS` и тип `Internal` экрана согласия Google;
- передавай `ATS_API_KEY` в заголовке `X-API-Key`, а не в query: query-строки попадают в логи прокси;
- периодически меняй `ATS_API_KEY`; смена `SESSION_SECRET` разлогинит всех пользователей;
- `DATABASE_SSL=true` включает TLS без проверки сертификата сервера — для недоверенных сетей используй приватную сеть до БД;
- `GOOGLE_DRIVE_REFRESH_TOKEN` и ключ сервисного аккаунта — секреты с полным доступом к Google Drive соответствующего аккаунта (scope `drive`): храни их только в секретах окружения и никогда не коммить;
- заведи для ATS отдельный Google-аккаунт, которому принадлежит папка «Кандидаты», а не используй личный: при утечке токена под угрозой только файлы ATS;
- настрой резервное копирование PostgreSQL; резюме в Google Drive удаляются только в корзину, но папку «Кандидаты» тоже стоит периодически выгружать (например, через Google Takeout).
