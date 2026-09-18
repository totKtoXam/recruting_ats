# Recruiting ATS Resume Intake API

API вынесен в отдельный Apps Script Web App, чтобы основная ATS с персональными данными не становилась публичной.

Основная ATS остаётся `ANYONE` (только авторизованные Google-пользователи). API deployment использует `ANYONE_ANONYMOUS` и защищён `ATS_API_KEY`.

## 1. Отдельный Apps Script проект

Код находится в `api-src/`.

Создай отдельный standalone Apps Script проект с `rootDir: api-src`. Содержимое его `.clasp.json` сохрани в GitHub Secret `API_CLASP_JSON`.

## 2. Script Properties API проекта

| Property | Значение |
|---|---|
| `SPREADSHEET_ID` | ID таблицы Recruiting ATS |
| `CANDIDATES_FOLDER_ID` | ID папки кандидатов |
| `UI_WEB_APP_URL` | URL основной ATS |
| `ATS_API_KEY` | API key |

API key можно сгенерировать функцией `setupApiAccess()` в API-проекте.

## 3. Deployment

Первый API deployment: Execute as Me; access — Anyone, включая anonymous (`ANYONE_ANONYMOUS`).

Deployment ID сохрани в GitHub Secret `API_GAS_DEPLOYMENT_ID`.

Сам API URL сохрани как Repository Variable `API_WEB_APP_URL`. GitHub Actions после этого будет обновлять API deployment вместе с основной ATS.

## 4. Получить справочники

`GET {API_WEB_APP_URL}?api=references&api_key={ATS_API_KEY}`

Возвращает вакансии, источники и ответственных.

## 5. Создать предзаполненный черновик

`POST {API_WEB_APP_URL}?api=candidate-draft&api_key={ATS_API_KEY}`

JSON body поддерживает: `lastName`, `firstName`, `middleName`, `phone`, `email`, `telegram`, `github`, `linkedin`, `salary`, `vacancyId`, `sourceId`, `responsibleId`, `comment`, `links` и опциональный `resume` с `name`, `mimeType`, `base64`.

Ответ содержит `draftUrl`. По нему основная ATS открывает форму нового кандидата и подставляет распарсенные данные. Оригинальный файл резюме, если передан API, переносится в папку кандидата только после нажатия «Сохранить».

API не создаёт кандидата автоматически.

## 6. Skill

Готовые файлы:

- `skills/recruiting-ats-resume/SKILL.md`
- `skills/recruiting-ats-resume/openapi.yaml`

В `openapi.yaml` замени `REPLACE_WITH_DEPLOYMENT_ID` на Deployment ID именно API deployment. API key подключается как query API key `api_key`.

## 7. Черновики

Черновик живёт 7 дней и после успешного создания кандидата помечается использованным. Старые записи можно удалять функцией основной ATS `cleanupExpiredCandidateDrafts()`.