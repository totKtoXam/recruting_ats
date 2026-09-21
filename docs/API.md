# Recruiting ATS API

В документе описаны:

1. **Resume Intake API** (`/intake`) — внешний API для AI-интеграций: справочники и создание предзаполненных черновиков кандидатов.
2. **Внутренний RPC** (`/api/rpc/:name`) — эндпоинт, через который работает фронтенд ATS.

Оба API обслуживаются тем же сервером, что и основное приложение. Отдельный deployment больше не нужен.

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

Возвращает вакансии, источники и ответственных, чтобы подобрать `vacancyId`, `sourceId` и `responsibleId` для черновика. Удалённые записи не возвращаются.

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
      "number": 5,
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
| `salary` | string / number | Зарплатные ожидания |
| `vacancyId` | string | ID вакансии из `references` |
| `sourceId` | string | ID источника из `references` |
| `responsibleId` | string | ID ответственного (рекрутера) из `references` |
| `comment` | string | Комментарий |
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
- Использованные и просроченные черновики удаляются, а их файлы переносятся в корзину Google Drive командой `npm run cleanup-drafts`, которую нужно запускать по расписанию (cron, Kubernetes CronJob).

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

## Внутренний RPC

Фронтенд (`web/Scripts.html`) вызывает серверные методы через один эндпоинт. Это замена `google.script.run` из версии на Apps Script: имена методов и формат ответов сохранены.

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
- Метод получает один аргумент — значение `args` (id, объект или ничего).

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
| `404` | Неизвестный метод или запись не найдена |
| `409` | Нарушение уникальности (например, источник с таким названием уже есть) |
| `415` | Тело не `application/json` |
| `500` | Внутренняя ошибка |

### Методы

Реестр — `server/rpc.js`.

**Загрузка данных**

| Метод | Аргумент | Назначение |
|---|---|---|
| `getBootstrapData` | — | Стартовые данные: пользователь, справочники, активные кандидаты, статистика |
| `getInitialData` | — | Алиас `getBootstrapData` |
| `getReferenceData` | — | Вакансии, источники, ответственные, шаблоны, справочники |
| `getCandidateData` | — | Активные кандидаты и статистика |
| `getArchivedCandidateData` | — | Архивные кандидаты |
| `getAdminUserData` | — | Список пользователей для админ-панели |

**Кандидаты**

| Метод | Аргумент | Назначение |
|---|---|---|
| `getCandidateDetails` | id кандидата | Полная карточка кандидата |
| `saveCandidate` | объект кандидата | Создание / изменение кандидата (в т.ч. из черновика) |
| `archiveCandidate` | id кандидата | Перенос в архив |
| `getAllowedTransitions` | id кандидата | Допустимые переходы статуса |
| `getCandidateTransitionStatusLog` | id кандидата | Журнал переходов статусов |
| `getCandidateDraft` | token черновика | Данные черновика из Resume Intake API |

**Интервью и переходы**

| Метод | Аргумент | Назначение |
|---|---|---|
| `getInterviews` | id кандидата | История результатов интервью |
| `getInterviewContext` | объект | Шаблон и контекст для перехода |
| `transitionCandidate` | объект | Переход статуса с результатом этапа |
| `updateInterview` | объект | Редактирование результата интервью |
| `deleteInterview` | id интервью | Удаление результата интервью |

**Админ-панель**

| Метод | Аргумент | Назначение |
|---|---|---|
| `saveVacancy` / `deleteVacancy` | объект / id | Вакансии |
| `saveSource` / `deleteSource` | объект / id | Источники |
| `saveResponsible` / `deleteResponsible` | объект / id | Ответственные |
| `saveInterviewTemplate` / `deleteInterviewTemplate` | объект / id | Шаблоны интервью |

Пример вызова из браузера (сессия уже есть):

```js
const response = await fetch('/api/rpc/getCandidateDetails', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ args: candidateId })
});
const { result, error } = await response.json();
```
