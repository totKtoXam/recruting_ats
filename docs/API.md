# Recruiting ATS API

В документе описаны:

1. **Resume Intake API** (`/intake`) — внешний API для AI-интеграций: справочники и создание предзаполненных черновиков кандидатов.
2. **MCP-сервер** (`/mcp`) — подключение Claude и других AI-ассистентов от имени пользователя (OAuth 2.1).
3. **Внутренний RPC** (`/api/rpc/:name`) — эндпоинт, через который работает фронтенд ATS.

Все API обслуживаются тем же сервером, что и основное приложение. Отдельный deployment больше не нужен.

## Swagger UI

`{PUBLIC_URL}/api/docs` — интерактивная документация всего HTTP API (OpenAPI 3.1): все RPC-методы с аргументами и ответами, Intake API, MCP, OAuth, файлы и служебные эндпоинты. Спецификация — `{PUBLIC_URL}/api/openapi.json`.

- Страница, её ресурсы и спецификация доступны только вошедшим пользователям ATS; без сессии — редирект на вход (`401` для `openapi.json`).
- «Try it out» для RPC отправляет запрос с cookie сессии — от имени и с правами текущего пользователя, изменения пишутся в журнал.
- Для Intake API ключ вводится в **Authorize** (`intakeApiKey`), для MCP — OAuth access-токен или личный токен (`mcpBearer` / `mcpPersonalToken`). Введённые ключи не сохраняются между перезагрузками страницы.
- Методы, которые меняют данные, помечены в спецификации `x-ats-writes: true` и предупреждением в описании (чтение — методы `get*`, `list*`, `find*`, `parse*`). При `SWAGGER_CONFIRM_WRITES=true` (по умолчанию — при `NODE_ENV=production`) Swagger UI перед таким запросом спрашивает подтверждение; в шапке страницы видно окружение.
- «Скачать openapi.json» в шапке — спецификация для Postman, Insomnia или генератора клиента. Из репозитория: `npm run openapi:export` (файл `openapi.json`).

Описания RPC-методов лежат в `server/openapi/rpc/*.js`, сборка спецификации — `server/openapi/index.js`. Тест `test/openapi.test.js` падает, если метод добавлен в `server/rpc.js` без описания (или описание осталось от удалённого метода). CI проверяет спецификацию линтером Redocly (`npm run openapi:lint`).

### Настройки → Для разработчиков

Вкладка видна всем вошедшим пользователям (RPC `getDeveloperInfo`): ссылки на Swagger, `openapi.json`, репозиторий (`REPOSITORY_URL`) и это руководство; версия сборки — коммит из git (в Docker-образе без `.git` — `BUILD_COMMIT`, `docker build --build-arg BUILD_COMMIT=$(git rev-parse HEAD) .`) и время запуска; команды подключения Claude (MCP) и адрес Intake API с признаком «ключ задан». Администраторам — состояние интеграций: PostgreSQL (задержка и последняя миграция), доступ к папке Google Drive (живая проверка до 5 с), Telegram-бот, SMTP, режим входа, Intake API.

## Resume Intake API

API создаёт **черновик** кандидата и возвращает ссылку на форму нового кандидата с подставленными данными. Кандидат создаётся только после того, как пользователь проверит форму и нажмёт «Сохранить». API никогда не создаёт кандидата автоматически.

Базовый URL:

```text
{PUBLIC_URL}/intake
```

Все ответы — JSON. Успешный ответ содержит `"ok": true`, ошибка — `"ok": false` и текст в поле `error`.

### Аутентификация

Ключ задаётся переменной окружения `ATS_API_KEY` на сервере. Сгенерировать:

```bash
node -e "console.log('ats_'+require('crypto').randomBytes(24).toString('hex'))"
```

Ключ можно передать одним из способов (проверяются в этом порядке):

| Способ | Пример |
|---|---|
| Заголовок `X-API-Key` (рекомендуется) | `X-API-Key: ats_...` |
| Query-параметр `api_key` | `/intake?api=meta&api_key=ats_...` |
| Поле `apiKey` в JSON body (только POST) | `{"apiKey": "ats_...", ...}` |

Заголовок предпочтительнее: query-строки попадают в логи reverse proxy. Query-параметр поддерживается для клиентов, которые не умеют передавать заголовки (например, API key в query в OpenAPI Skill).

Ключ сравнивается за постоянное время. Cookie-сессия для `/intake` не используется.

В примерах ниже:

```bash
ATS_URL=https://ats.example.com
ATS_API_KEY=ats_...
```

### `GET /intake?api=meta`

Проверка доступности и ключа.

```bash
curl -s "$ATS_URL/intake?api=meta" -H "X-API-Key: $ATS_API_KEY"
```

```json
{
  "ok": true,
  "webAppUrl": "https://ats.example.com"
}
```

### `GET /intake?api=references`

Возвращает вакансии, источники и ответственных, чтобы подобрать `vacancyId`, `sourceId` и `responsibleId` для черновика. Архивные и удалённые записи не возвращаются.

Ответственные — это пользователи ATS, у которых в «Настройки → Пользователи» отмечен хотя бы один этап («Ответственный за этапы»); доступ в ATS им не обязателен. `id` ответственного — ID пользователя. Номера (`number`) у ответственных нет.

```bash
curl -s "$ATS_URL/intake?api=references" -H "X-API-Key: $ATS_API_KEY"
```

```json
{
  "ok": true,
  "webAppUrl": "https://ats.example.com",
  "vacancies": [
    {
      "id": "3f1c2a9e-1b7d-4c55-9f0a-2d8e6b1c4a10",
      "number": 12,
      "name": "Senior Java Developer",
      "status": "Открыта"
    }
  ],
  "sources": [
    {
      "id": "8a2d4f60-5e3b-4b1a-a7c9-0e6f2b9d1c33",
      "number": 3,
      "name": "LinkedIn"
    }
  ],
  "responsibles": [
    {
      "id": "c9e7b1d2-4a6f-4e08-b3d5-7f1a2c8e9b44",
      "lastName": "Иванова",
      "firstName": "Анна",
      "middleName": "",
      "fullName": "Иванова Анна",
      "stages": ["Новый", "HR screening"]
    }
  ]
}
```

При сохранении кандидата в форме можно выбрать только вакансию со статусом `Открыта`.

### `POST /intake?api=candidate-draft`

Создаёт черновик кандидата. Action можно передать в query `api=candidate-draft` или в поле `action` body.

Тело запроса — JSON (не больше 15 МБ; разбирается как JSON при любом `Content-Type`). Невалидный JSON → `400`. Все поля необязательные:

| Поле | Тип | Описание |
|---|---|---|
| `lastName` | string | Фамилия |
| `firstName` | string | Имя |
| `middleName` | string | Отчество |
| `phone` | string | Телефон (в форме проверяется как мобильный номер РК) |
| `email` | string | Email (приводится к нижнему регистру) |
| `telegram` | string | Telegram username или ссылка |
| `github` | string | GitHub |
| `linkedin` | string | LinkedIn |
| `salary` | string / number | Зарплатные ожидания (хранятся зашифрованными; в ATS видны только пользователям с доступом к ЗП) |
| `vacancyId` | string | ID вакансии из `references` |
| `sourceId` | string | ID источника из `references` |
| `responsibleId` | string | ID ответственного (рекрутера) из `references` — это ID пользователя |
| `comment` | string | Комментарий: обычный текст; при сохранении кандидата становится первым комментарием в его ленте (текст экранируется и сохраняется как HTML) |
| `links` | array | Дополнительные ссылки: `[{ "name": "...", "url": "..." }]` |
| `resume` | object | Файл резюме: `{ "name": "cv.pdf", "mimeType": "application/pdf", "base64": "..." }` |

Данные черновика на этом шаге не валидируются как кандидат: полная проверка (обязательные поля, телефон, email, справочники) выполняется при сохранении формы. Проверяется только файл резюме:

- расширение `pdf`, `doc` или `docx` (по полю `name`);
- размер после декодирования — не больше 10 МБ;
- файл не пустой.

`base64` может быть как «чистым», так и data URL (`data:application/pdf;base64,...`).

Пример:

```bash
curl -s -X POST "$ATS_URL/intake?api=candidate-draft" \
  -H "X-API-Key: $ATS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "lastName": "Петров",
    "firstName": "Сергей",
    "phone": "+7 701 123 45 67",
    "email": "petrov@example.com",
    "telegram": "@spetrov",
    "vacancyId": "3f1c2a9e-1b7d-4c55-9f0a-2d8e6b1c4a10",
    "comment": "Распарсено из резюме",
    "links": [{ "name": "Портфолио", "url": "https://example.com/petrov" }]
  }'
```

С файлом резюме:

```bash
jq -n --arg b64 "$(base64 -w0 cv.pdf)" \
  '{lastName: "Петров", firstName: "Сергей",
    resume: {name: "cv.pdf", mimeType: "application/pdf", base64: $b64}}' |
curl -s -X POST "$ATS_URL/intake?api=candidate-draft" \
  -H "X-API-Key: $ATS_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @-
```

Ответ:

```json
{
  "ok": true,
  "draftToken": "5d0c9e2a7b4f41c8a3e61f0d2b9c7a58",
  "draftUrl": "https://ats.example.com/?draft=5d0c9e2a7b4f41c8a3e61f0d2b9c7a58",
  "webAppUrl": "https://ats.example.com",
  "expiresAt": "2026-09-28T10:15:00.000Z",
  "resume": {
    "id": "0b6e1f3a-9c2d-4e7b-8a15-3d4c2e1f0a99",
    "name": "cv.pdf",
    "url": "https://ats.example.com/files/0b6e1f3a-9c2d-4e7b-8a15-3d4c2e1f0a99"
  }
}
```

`resume` равен `null`, если файл не передавался.

`draftUrl` открывает форму нового кандидата с подставленными данными (нужен вход в ATS). Файл резюме хранится в Google Drive в папке `_ATS_Черновики` (внутри корневой папки «Кандидаты») и копируется в папку кандидата только после нажатия «Сохранить». `resume.url` отдаёт файл через ATS и, как и `draftUrl`, требует входа в ATS; доступ к Drive пользователю не нужен.

### Жизненный цикл черновика

- Черновик живёт **7 дней** (`expiresAt`).
- После успешного создания кандидата черновик помечается использованным; повторно открыть его нельзя.
- Использованные и просроченные черновики удаляются, а их файлы переносятся в корзину Google Drive. Очистка запускается сервером автоматически при открытии приложения (не чаще раза в 12 часов), cron не нужен; вручную — `npm run cleanup-drafts`.

### Ошибки

| HTTP | Когда | Пример `error` |
|---|---|---|
| `400` | Неизвестный или не указанный `api` action | `Неизвестный API action.` |
| `400` | Ошибка валидации резюме | `Допустимые форматы резюме: PDF, DOC, DOCX.`, `Размер резюме не должен превышать 10 МБ.`, `Файл резюме пустой.` |
| `401` | Ключ не передан или неверен | `Некорректный API key.` |
| `503` | На сервере не задан `ATS_API_KEY` | `API не настроен: задайте переменную окружения ATS_API_KEY.` |
| `500` | Внутренняя ошибка (подробности — в логах сервера) | `Внутренняя ошибка сервера.` |

Формат ошибки:

```json
{
  "ok": false,
  "error": "Некорректный API key."
}
```

Ключ проверяется до разбора action, поэтому при неверном ключе всегда возвращается `401`.

### Skill и OpenAPI

Готовые файлы для AI-ассистента:

- `skills/recruiting-ats-resume/SKILL.md` — инструкция по разбору резюме и созданию черновика;
- `skills/recruiting-ats-resume/openapi.yaml` — описание API (операции `getReferences` и `createCandidateDraft`).

В `openapi.yaml` замени `servers[0].url` на `PUBLIC_URL` своей установки. API key подключается как query-параметр `api_key`.

## MCP-сервер для Claude

`{PUBLIC_URL}/mcp` — сервер [Model Context Protocol](https://modelcontextprotocol.io) (транспорт Streamable HTTP, JSON-ответы, без сессий). Через него Claude (Claude Code, Claude Desktop и другие MCP-клиенты) работает с ATS **от имени пользователя**: с его правами, а все изменения пишутся в журнал под его именем.

### Подключение и авторизация (OAuth 2.1)

Клиенту достаточно адреса `{PUBLIC_URL}/mcp` — остальное он находит сам:

1. `POST /mcp` без токена → `401` с `WWW-Authenticate: Bearer resource_metadata="{PUBLIC_URL}/.well-known/oauth-protected-resource"`.
2. Метаданные ресурса (RFC 9728) и сервера авторизации (RFC 8414). Отдаются и под `BASE_PATH` (`{PUBLIC_URL}/.well-known/oauth-authorization-server`, `…/openid-configuration`), и в корне домена (`/.well-known/oauth-authorization-server{BASE_PATH}`, `/.well-known/openid-configuration{BASE_PATH}`) . Claude Code ищет метаданные в корне домена (`/.well-known/oauth-protected-resource{BASE_PATH}/mcp`, `/.well-known/oauth-authorization-server{BASE_PATH}`): если reverse proxy их не пропускает, клиент считает сервером авторизации корень домена и регистрация падает с 404 — пример nginx см. в README, раздел «Reverse proxy и HTTPS». Документ `openid-configuration` содержит обязательные поля OpenID Discovery (`jwks_uri` → пустой `/oauth/jwks`), ID-токены не выдаются.
3. Клиент регистрируется сам: `POST /oauth/register` (RFC 7591; только публичные клиенты, `redirect_uris` — `https://…` или `http://localhost|127.0.0.1|[::1]`).
4. `GET /oauth/authorize` (PKCE S256 обязателен) → вход в ATS через Google, если сессии нет → страница согласия «Разрешить / Отмена» → редирект с `code`.
5. `POST /oauth/token`: `authorization_code` (код одноразовый, 10 минут) и `refresh_token` (ротация: старый refresh-токен перестаёт действовать). Access-токен живёт 1 час, refresh — 90 дней. `POST /oauth/revoke` — отзыв (RFC 7009).

В БД хранятся только SHA-256 токенов и кодов (миграция `012_oauth_mcp.sql`: `oauth_clients`, `oauth_codes`, `oauth_grants`). Если пользователю закрыли доступ в ATS, его токены перестают работать сразу. Свои подключения пользователь видит и отключает в «Профиль → ИИ-ассистенты» (RPC `listMcpConnections`, `revokeMcpConnection`).

### Личные токены

Если клиент не может пройти OAuth (например, reverse proxy не пропускает `/.well-known/*`), пользователь выпускает **личный токен** в «Профиль → ИИ-ассистенты»: название, срок (30 / 90 / 365 дней или без срока), не больше 10 действующих. Токен (`atsp_…`) показывается один раз; в БД хранится только SHA-256 и первые символы для узнавания (миграция `013_mcp_personal_tokens.sql`). Переименование и отзыв — там же (RPC `createMcpToken`, `renameMcpToken`, `revokeMcpToken`; список — в `listMcpConnections.tokens`). Переименование меняет только название: сам токен, срок и доступ остаются прежними.

Токен передаётся в заголовке `X-ATS-Token: <токен>` (или `Authorization: Bearer <токен>`). Плагин Claude Code использует `X-ATS-Token` из переменной `ATS_MCP_TOKEN`: если в конфиге задан заголовок `Authorization`, Claude Code отключает запасной вход через OAuth, а с отдельным заголовком без токена по-прежнему работает кнопка «Authenticate». Инструменты с токеном выполняются от имени его владельца; если доступ пользователя к ATS закрыт, токен перестаёт работать.

### Инструменты

Реестр — `server/mcp/tools.js`. Инструменты вызывают те же сервисы и RPC-методы, что и интерфейс, поэтому права, проверки и журнал общие. У инструментов чтения — `readOnlyHint: true`; инструменты записи в описании требуют показать пользователю превью и получить подтверждение (то же правило — в `instructions` ответа `initialize`).

| Группа | Инструменты |
|---|---|
| Чтение | `get_references`, `search_candidates`, `get_candidate`, `get_resume_text`, `find_similar_candidates`, `parse_resume`, `get_interview_context`, `list_comments`, `get_history`, `get_dashboard`, `list_records`, `get_notifications`, `create_upload_link` |
| Кандидаты | `create_candidate_draft`, `save_candidate` (создание; изменение — только переданные поля), `transition_candidate`, `update_interview`, `set_record_state`, `set_candidate_watch`, `mark_notifications_read` |
| Комментарии и журнал | `add_comment`, `edit_comment`, `delete_comment`, `toggle_reaction`, `revert_change` |
| Справочники | `save_vacancy` (`presetId` — этапы из шаблона вакансии), `set_vacancy_status`, `save_vacancy_preset` (шаблон вакансии; `fromVacancyId` — этапы из вакансии), `save_source`, `save_interview_template` |
| Пользователи (админ) | `save_user`, `set_user_access` |

Ошибки бизнес-правил возвращаются результатом инструмента с `isError: true` и текстом, как в интерфейсе. Относительные ссылки ATS (`/files/…`, `/candidates/…`) в ответах превращаются в абсолютные.

### Загрузка резюме

Чтобы не передавать файл base64 через контекст модели, `create_upload_link` выдаёт одноразовую ссылку (30 минут, хранится в памяти процесса):

```bash
curl -sS -X POST --data-binary @cv.pdf -H "Content-Type: application/octet-stream" \
  "$PUBLIC_URL/mcp/uploads/<uploadId>?name=cv.pdf"
```

Затем `uploadId` передаётся в `parse_resume`, `create_candidate_draft` (`resumeUploadId`) или `save_candidate` (`resumeUploadId`). Без shell можно передать файл в `file` / `resumeFile` как `{ name, mimeType, base64 }`.

### Плагин Claude Code

`plugins/recruiting-ats` — плагин с MCP-сервером, скиллом `recruiting-ats` (правила, превью форм перед записью, сценарии) и командами (`/recruiting-ats:candidate`, `:resume`, `:move`, `:reject`, `:comment`, `:pipeline`, `:today`, `:report`, `:form-mode`, `:interview-kit`, `:screen`, `:tech-interview`, `:debrief`), а также скиллами собеседований: `interview-design` (шаблоны вопросов по этапам со шкалой оценки), `hr-screening`, `tech-interview-dotnet`, `interview-debrief` (методика — по открытым материалам, см. `plugins/recruiting-ats/NOTICE.md`). Маркетплейс — `.claude-plugin/marketplace.json` в корне репозитория. Адрес сервера по умолчанию — `https://portal.devexpert.kz/hr-ats/mcp`, другой задаётся переменной окружения `ATS_MCP_URL` до запуска Claude Code.

```text
/plugin marketplace add totKtoXam/recruting_ats
/plugin install recruiting-ats@recruiting-ats
/mcp   → recruiting-ats → Authenticate
```

С личным токеном — `ATS_MCP_TOKEN` в `env` файла `~/.claude/settings.json` (подсказка с готовым блоком показывается при создании токена). Без плагина сервер подключается напрямую: `claude mcp add --transport http recruiting-ats https://portal.devexpert.kz/hr-ats/mcp` (OAuth) или с `--header "X-ATS-Token: <токен>"`. В claude.ai / Claude Desktop — «Настройки → Коннекторы → Добавить свой коннектор» с тем же адресом; для этого сервер должен быть доступен из интернета по HTTPS.

## Внутренний RPC

Фронтенд (`web/Scripts.html`, `web/AdminScripts.html`, `web/Comments.html`) вызывает серверные методы через один эндпоинт. Это замена `google.script.run` из версии на Apps Script: формат вызова и ответов сохранён, набор методов с тех пор расширен (архив и корзина, комментарии, пользователи-ответственные).

Этот API предназначен только для фронтенда ATS и не является стабильным внешним контрактом.

### Запрос

```text
POST /api/rpc/:name
Content-Type: application/json
Cookie: ats.sid=...

{ "args": <аргумент метода> }
```

- Требуется авторизованная сессия (cookie `ats.sid`), иначе `401`.
- Принимается только `Content-Type: application/json`, иначе `415`.
- Лимит тела — 20 МБ (резюме передаются в base64).
- Метод получает один аргумент — значение `args` (id, объект или ничего). `"args": null` равносилен отсутствию аргумента.
- Пустые и неверные аргументы дают ошибку валидации (4xx), а не `500`: CI вызывает каждый метод с `undefined`, `null`, `{}`, `[]`, строкой и числом (`scripts/check-rpc-args.js`, только на отдельной БД — методы могут записывать данные).

### Ответ

Успех:

```json
{ "result": { ... } }
```

Ошибка:

```json
{ "error": { "message": "Кандидат не найден." } }
```

| HTTP | Когда |
|---|---|
| `400` | Ошибка валидации / бизнес-правила |
| `401` | Нет сессии |
| `403` | Недостаточно прав (действие только для администраторов, чужой комментарий) |
| `404` | Неизвестный метод или запись не найдена |
| `409` | Нарушение уникальности (например, источник с таким названием уже есть) |
| `415` | Тело не `application/json` |
| `500` | Внутренняя ошибка |

### Методы

Реестр — `server/rpc.js`.

**Загрузка данных**

| Метод | Аргумент | Назначение |
|---|---|---|
| `getBootstrapData` | — | Стартовые данные: пользователь, справочники, активные кандидаты, статистика. Заодно запускает в фоне очистку черновиков и окончательное удаление из корзины (каждое не чаще раза в 12 часов) |
| `getInitialData` | — | Алиас `getBootstrapData` |
| `getReferenceData` | — | Активные вакансии, источники, ответственные (пользователи с этапами), шаблоны вопросов, шаблоны вакансий (`vacancyPresets`), справочники, переходы статусов вакансии (`vacancyStatusTransitions`), срок хранения в корзине (`trashRetentionDays`) |
| `getCandidateData` | — | Активные кандидаты и статистика |
| `getArchivedCandidateData` | — | Архивные кандидаты (`{ archivedCandidates }`) |
| `getDeletedCandidateData` | — | Кандидаты в корзине (`{ deletedCandidates }`) |
| `getAdminUserData` | — | Пользователи с доступом (не в архиве и не в корзине) |

**Кандидаты**

| Метод | Аргумент | Назначение |
|---|---|---|
| `getCandidateDetails` | id кандидата | Полная карточка кандидата |
| `saveCandidate` | объект кандидата | Создание / изменение кандидата (в т.ч. из черновика). Рекрутер, HR и проф. интервьювер — ID пользователей-ответственных. `comment` при создании становится первым комментарием в ленте кандидата |
| `archiveCandidate` | id кандидата | Перенос в архив (статус сохраняется) |
| `unarchiveCandidate` | id кандидата | Возврат из архива |
| `getAllowedTransitions` | id кандидата | Допустимые переходы статуса |
| `getCandidateTransitionStatusLog` | id кандидата | Журнал переходов статусов |
| `getCandidateDraft` | token черновика | Данные черновика из Resume Intake API |
| `parseResume` | `{ name, mimeType, base64 }` — файл резюме, как в `saveCandidate` | Разбор резюме для автозаполнения формы, ничего не сохраняет. Ответ: `status` (`ok` \| `scan` \| `not_resume`; у последних двух — `message`), `format` (`hh` \| `enbek` \| `linkedin` \| `generic`), `fields` (значение, `confidence` `high`/`medium` и фрагмент-источник) для `lastName`, `firstName`, `middleName`, `phone`, `email`, `telegram`, `github`, `linkedin`, `salary`; `suggestions` (неуверенные варианты; у `name` значение — объект Ф/И/О), `warnings`, `links` (профили для «Иных ссылок»), `hints` (`vacancy`, `source`: id, `confidence`, причина), `duplicates` (кандидаты с тем же email, телефоном или Telegram, включая архив и корзину), `summary` (строки для комментария), `hh` (события отклика/отказа, комментарии рекрутера, сопроводительное письмо), `fileHash` |
| `findSimilarCandidates` | `{ lastName, firstName, middleName, email, phone, telegram, excludeId? }` | До 5 похожих кандидатов (включая архив и корзину): `id`, `number`, `fullName`, `vacancy`, `status`, `state` (`active` \| `archived` \| `deleted`), `matchedBy` (`email`, `phone`, `telegram` — точно; `name` — ФИО по Дамерау — Левенштейну), `nameScore` 0..1 |

**Интервью и переходы**

| Метод | Аргумент | Назначение |
|---|---|---|
| `getInterviews` | id кандидата | История результатов интервью |
| `getInterviewContext` | объект | Шаблон и контекст для перехода |
| `transitionCandidate` | объект | Переход статуса: `{ candidateId, toStatus, interview }` — результат этапа, на который переводят (`interview.answers` — ответы на вопросы шаблона по порядку, затем свои вопросы интервьюера с `custom: true`); `{ candidateId, toStatus: 'Отказано', rejection: { byType: 'candidate' \| 'responsible', responsibleId, reason, comment } }` — отказ; `{ candidateId, toStatus, comment }` — возврат из «Отказано» на этап отказа |
| `updateInterview` | объект | Редактирование результата интервью (ответы и результат — HTML, санитизируется на сервере). Ответ — `{ question, answer, files?, skipped }`; `skipped: true` — вопрос не задавался (допускается и в обязательном шаблоне); `files` — вложения `[{ id }]` из `uploadAttachment`, ключ не передан — вложения ответа на этот вопрос не меняются |
| `uploadAttachment` | `{ name, mimeType?, base64 }` | Вложение к вопросу шаблона или ответу интервью (pdf, документы, таблицы, изображения, zip, mp3/mp4 — до 10 МБ). Возвращает `{ ok, file: { id, name, mimeType, size, url } }`; `id` передаётся в `files`. Файл без ссылок удаляется через 48 часов |

**Архив и корзина** (для `type`: `candidate`, `vacancy`, `vacancy_preset`, `source`, `template`, `interview`, `user`)

| Метод | Аргумент | Назначение |
|---|---|---|
| `archiveEntity` / `unarchiveEntity` | `{ type, id }` | Архивировать / вернуть из архива |
| `deleteEntity` | `{ type, id }` | Удалить в корзину. **Только администраторы** и только архивную запись. Через `trashRetentionDays` (30) дней запись удаляется из БД окончательно |
| `restoreEntity` | `{ type, id }` | Вернуть из корзины в архив (пока не прошло 30 дней). **Только администраторы** |
| `getDeletedCandidateData` | — | Кандидаты в корзине |

**Комментарии** (`entityType`: `candidate`, `vacancy`, `interview`)

| Метод | Аргумент | Назначение |
|---|---|---|
| `listComments` | `{ entityType, entityId }` | Комментарии с ответами (один уровень) и реакциями |
| `addComment` | `{ entityType, entityId, bodyHtml, parentId? }` | Новый комментарий или ответ. Нельзя для записей в корзине |
| `updateComment` | `{ id, bodyHtml }` | Правка (только автор) |
| `deleteComment` | id | Удаление (автор или администратор) |
| `toggleReaction` | `{ commentId, emoji }` | Поставить/снять реакцию: 👍 👎 ❤️ 😂 🎉 👀 |

**Уведомления** (методы работают с уведомлениями текущего пользователя)

| Метод | Аргумент | Назначение |
|---|---|---|
| `getNotificationFeed` | `{ view: 'recent' \| 'unread' \| 'important', limit?, before? }` | Лента колокольчика (только канал «В приложении»): `{ items, hasMore, unread }`. `before` — `createdAt` последнего элемента для подгрузки |
| `getNotificationUnread` | — | `{ unread }` — число непрочитанных (также `notificationsUnread` в `getBootstrapData`) |
| `getNotification` | id | Уведомление с актуальными статусами доставки (`channels: [{ channel, status, recipient, attempts, error, sentAt }]`) |
| `markNotificationRead` | `{ id, read? }` | Отметить прочитанным (`read: false` — непрочитанным) |
| `markAllNotificationsRead` | — | Отметить все прочитанными |
| `setNotificationImportant` | `{ id, important }` | Отметка «Важное» |
| `listNotificationLog` | как у `list*` | Журнал. Фильтры: `q`, `kind`, `read` (`read`/`unread`), `important` (`yes`/`no`), `delivery` (`sent`/`pending`/`failed`/`skipped`/`app`) |
| `getNotificationSettings` | — | Виды, каналы (с доступностью и причиной), `preferences[kind][channel]`, email, состояние Telegram |
| `setNotificationPreference` | `{ kind, channel, enabled }` | Включить или выключить вид по каналу |
| `setNotificationPreferences` | `{ items: [{ kind, channel, enabled }] }` | То же пачкой |
| `getCandidateWatch` / `setCandidateWatch` | id / `{ candidateId, watch }` | «Следить» за кандидатом: `{ watching, watchers }` |
| `createTelegramLink` | — | Одноразовая ссылка привязки `{ url, expiresAt }` (15 минут) |
| `unlinkTelegram` | — | Отвязать Telegram |

**Интеграции** (только администраторы, иначе `403`; `group`: `auth` \| `smtp` \| `telegram`)

| Метод | Аргумент | Назначение |
|---|---|---|
| `getIntegrationSettings` | — | Группы с полями: значение (у секретов — только `isSet` и `hintValue`), источник `db` / `env` / `default` / `none`; `info` — Redirect URI, JS origin, администраторы из `.env` |
| `testIntegration` | `{ group, values }` | Проверка с учётом несохранённых значений: Google — Client ID/secret, SMTP — тестовое письмо текущему пользователю, Telegram — `getMe` |
| `saveIntegration` | `{ group, values: { 'smtp.host': '…', … } }` | Сохранить изменённые поля (пустой секрет — не менять) и применить без перезапуска. Client ID/secret перед сохранением проверяются в Google |
| `resetIntegration` | `{ group }` | Удалить значения группы, сохранённые в ATS, — действует `.env` |

**Админ-панель**

| Метод | Аргумент | Назначение |
|---|---|---|
| `listVacancies` / `listVacancyPresets` / `listTemplates` / `listSources` / `listUsers` | `{ page, pageSize, sort: { key, dir }, filters }` | Страница таблицы: фильтры, сортировка и пагинация выполняются в БД. `filters.state`: `active` / `archived` / `deleted`. Ответ `{ items, total, page, pageSize, sort }`; `pageSize` до 100. `listUsers` — **только администраторы** |
| `saveVacancy` | `{ id?, name, links?, templates?, presetId? }` | Вакансия (название уникально без учёта регистра, иначе `409`); новая создаётся со статусом «Открыта». `templates` — все этапы `{ stage, templateId?, required }`. `presetId` — шаблон вакансии: без `templates` этапы копируются из него один раз (шаблон должен быть активным; этапы с шаблоном вопросов в архиве — без шаблона, в `skippedStages`); с `templates` — только ссылка. Новая вакансия запоминает шаблон в `presetId` |
| `setVacancyStatus` | `{ id, status }` | Переход статуса вакансии; допустимые переходы — `vacancyStatusTransitions` в `getReferenceData` |
| `saveVacancyPreset` | `{ id?, name, templates?, fromVacancyId? }` | Шаблон вакансии — готовые этапы (название уникально, иначе `409`). `templates` — как у `saveVacancy`; `fromVacancyId` без `templates` — взять этапы из вакансии. Шаблон в корзине не меняется |
| `saveSource` | `{ id?, name }` | Источник |
| `saveInterviewTemplate` | объект | Шаблон интервью; `questions` — массив `{ text, answers, files? }` (answers — предпочтительные ответы, files — материалы вопроса `[{ id }]` из `uploadAttachment`; ключ не передан — остаются прежние вложения вопроса с тем же текстом) |
| `saveUser` | `{ id?, email, lastName, firstName, middleName, stages, isActive, isAdmin, telegram? }` | Пользователь. Непустой `stages` делает его ответственным за этапы. `isActive` учитывается только при создании. **Только администраторы** |
| `setUserAccess` | `{ id, isActive }` | Открыть/закрыть доступ в ATS. **Только администраторы**; нельзя себе и последнему администратору |

Пример вызова из браузера (сессия уже есть):

```js
const response = await fetch('/api/rpc/getCandidateDetails', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ args: candidateId })
});
const { result, error } = await response.json();
```
