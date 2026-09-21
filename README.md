# Recruiting ATS

Лёгкая ATS (Applicant Tracking System) на Google Apps Script.

Данные хранятся в Google Sheets, файлы кандидатов — в Google Drive, а пользователи работают через Web App.

## Возможности

- Kanban по этапам найма с drag & drop, фильтрами и сворачиваемыми колонками.
- Google-авторизация через Apps Script Web App; пользователь идентифицируется по OpenID Connect `sub`.
- Таблица пользователей с автоматическим созданием записи при первом входе.
- Админ-панель: CRUD вакансий, источников, ответственных и шаблонов интервью.
- Ответственные ограничиваются доступными этапами найма.
- Карточка кандидата с обязательными ФИО, вакансией, телефоном, рекрутером, ответственным HR, ответственным тех. интервьювером и резюме.
- ФЛК мобильного номера Казахстана и email.
- Telegram username автоматически преобразуется в кликабельную ссылку.
- Загрузка PDF/DOC/DOCX резюме в персональную папку кандидата в Google Drive.
- Произвольные дополнительные ссылки кандидата.
- Управляемый pipeline: Новый ↔ HR screening ↔ Техническое интервью ↔ Финальное интервью ↔ Offer ↔ Hired.
- При каждом переходе между этапами запрашивается результат этапа/интервью.
- Для обязательного шаблона переход блокируется, пока не заполнены все его вопросы; проверка выполняется и на сервере.
- Каждый переход статуса пишется в append-only лист `Candidate Transition Status Log` с пользователем, выполнившим переход.
- Шаблон вопросов автоматически подбирается по вакансии и текущему этапу.
- История результатов интервью доступна для просмотра и редактирования.
- Архивирование сохраняет текущий статус и переносит кандидата из листа `Кандидаты` в отдельный лист `Архив кандидатов`.
- CI/CD через GitHub Actions + clasp.

## Архитектура

```text
Browser
  |
  v
Google Apps Script Web App
  |-- SpreadsheetApp --> Google Sheets
  |-- DriveApp -------> Google Drive / Кандидаты
  |
  v
Recruiting ATS

GitHub
  |
  v
GitHub Actions
  |
  v
clasp push + redeploy
  |
  v
Google Apps Script
```

## Оптимизация runtime

Стартовая загрузка ATS использует один RPC `getBootstrapData()`.

В bootstrap входят:

- текущий пользователь;
- вакансии, источники, ответственные, шаблоны и справочники;
- лёгкие карточки активных кандидатов;
- статистика.

Не загружаются при старте:

- архив кандидатов — загружается при включении фильтра «Архив»;
- история интервью — загружается при открытии конкретного кандидата;
- полный объект кандидата с историей резюме и дополнительными ссылками — загружается при открытии карточки;
- список пользователей для привязки ответственных — загружается при открытии админ-панели.

Дополнительно:

- `SpreadsheetApp.openById()` и `getSheetByName()` кэшируются в рамках server execution;
- справочники кэшируются через `CacheService` на 5 минут и инвалидируются после CRUD в админ-панели;
- статистика считается из уже загруженного массива кандидатов;
- после save/archive/transition статистика пересчитывается в браузере без отдельного RPC;
- запись `Последний вход` пользователя throttled на 30 минут, если профиль не изменился.

## Требования

- Google-аккаунт с доступом к нужной таблице и папке Drive.
- Node.js 22+.
- npm.
- Google Apps Script API должен быть включён:
  https://script.google.com/home/usersettings
- `@google/clasp` 3.x.

## Первичная инициализация схемы

Начиная с версии 2, приложение само создаёт недостающие листы и колонки. После первого `clasp push` открой Apps Script и один раз выполни функцию:

```text
setupApplication
```

Либо просто открой задеплоенный Web App. Runtime проверяет только `ATS_SCHEMA_VERSION`; тяжёлая миграция выполняется один раз при изменении версии схемы, а не при каждом открытии приложения.

Автоматически поддерживаются листы:

```text
Кандидаты
Архив кандидатов
Черновики кандидатов
Интервью
Вакансии
Источники
Ответственные
Пользователи
Candidate Transition Status Log
Шаблоны интервью
Справочники
```

Существующие данные не удаляются: миграция добавляет только отсутствующие листы и колонки.

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

Переход в архив доступен отдельно из любого активного этапа. Текущий статус кандидата сохраняется, запись переносится из листа `Кандидаты` в лист `Архив кандидатов`.

## 1. Подготовка Google Sheets

Создай Google Spreadsheet со следующими листами.

### Лист `Кандидаты`

Первая строка должна содержать заголовки:

```text
ID
ФИО
Вакансия
Статус
Телефон
Email
Telegram
Источник
Зарплатные ожидания
Резюме
Папка кандидата
Responsible ID
Ответственный
HR Responsible ID
Ответственный HR
Tech Interviewer ID
Ответственный тех. интервьювер
Дата добавления
Следующий контакт
Итог
Причина отказа
Комментарий
```

### Лист `Интервью`

```text
Interview ID
Candidate ID
ФИО
Вакансия
Тип интервью
Дата
Интервьюер
Вопрос
Ответ
Hard Skills
Soft Skills
Мотивация
Сильные стороны
Слабые стороны
Потенциал
Итог интервью
Рекомендация
Комментарий
```

### Лист `Вакансии`

```text
Vacancy ID
Вакансия
Статус
Направление
Грейд
Ответственный
Дата открытия
Дата закрытия
Комментарий
```

### Лист `Справочники`

Поддерживаются следующие колонки:

```text
Статусы кандидата
Типы интервью
Рекомендации
Статусы вакансии
Источники
Грейды
```

Пример статусов кандидата:

```text
Новый
HR screening
Техническое интервью
Финальное интервью
Offer
Hired
Отказ
Резерв
```

## 2. Подготовка Google Drive

Создай папку `Кандидаты`.

Для каждого нового кандидата Web App автоматически создаёт подпапку:

```text
Иванов Иван Иванович [a1b2c3d4]
```

Удаление кандидата из ATS не удаляет его папку и файлы в Google Drive.

## 3. Создание Apps Script проекта

Установи зависимости:

```bash
npm install
```

Авторизуй clasp:

```bash
npx clasp login
```

Создай standalone Apps Script Web App:

```bash
npx clasp create-script \
  --title "Recruiting ATS" \
  --type webapp \
  --rootDir src
```

После команды появится локальный `.clasp.json`.

> Не коммить `.clasp.json` и `.clasprc.json`. В проекте они находятся в `.gitignore`.

Если Apps Script проект уже существует, создай `.clasp.json` вручную по примеру `.clasp.json.example`:

```json
{
  "scriptId": "YOUR_SCRIPT_ID",
  "rootDir": "src"
}
```

Script ID можно взять в Apps Script:

`Project Settings -> IDs -> Script ID`.

## 4. Настройка Script Properties

Google Drive/Spreadsheet ID не хранятся в GitHub.

Открой Apps Script:

```bash
npx clasp open-script
```

Далее:

`Project Settings -> Script Properties -> Add script property`

Добавь:

| Property | Значение |
|---|---|
| `SPREADSHEET_ID` | ID Google Spreadsheet |
| `CANDIDATES_FOLDER_ID` | ID папки `Кандидаты` |

Пример URL таблицы:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

Пример URL папки:

```text
https://drive.google.com/drive/folders/CANDIDATES_FOLDER_ID
```

## 5. Локальный deploy

Проверь, какие файлы увидит clasp:

```bash
npm run status
```

Загрузи код:

```bash
npm run push
```

Создай первый deployment:

```bash
npx clasp create-deployment --description "Initial Recruiting ATS deployment"
```

Команда вернёт Deployment ID.

Web App URL можно посмотреть через список deployments:

```bash
npx clasp list-deployments
```

или открыть Apps Script editor и перейти в `Deploy -> Manage deployments`.

## 6. GitHub Actions

Workflow находится здесь:

```text
.github/workflows/deploy.yml
```

При push в `main` он:

1. устанавливает Node.js 22;
2. устанавливает зависимости;
3. восстанавливает OAuth credentials clasp;
4. восстанавливает `.clasp.json`;
5. выполняет `clasp push --force`;
6. обновляет существующий Web App deployment.

### GitHub Secrets

Открой:

`Repository -> Settings -> Secrets and variables -> Actions`

Создай три секрета.

### `CLASPRC_JSON`

После:

```bash
npx clasp login
```

возьми содержимое:

```text
~/.clasprc.json
```

и полностью сохрани его как GitHub Secret `CLASPRC_JSON`.

**Никогда не коммить этот файл. Он содержит OAuth refresh token.**

### `CLASP_JSON`

Содержимое локального `.clasp.json`, например:

```json
{
  "scriptId": "1AbCdEf...",
  "rootDir": "src"
}
```

сохрани в Secret `CLASP_JSON`.

### `GAS_DEPLOYMENT_ID`

Deployment ID, полученный после первого:

```bash
npx clasp create-deployment
```

Сохрани в Secret:

```text
GAS_DEPLOYMENT_ID
```

## 7. Автоматический deploy

После настройки secrets:

```bash
git add .
git commit -m "Update recruiting ATS"
git push origin main
```

GitHub Actions автоматически обновит существующий deployment.

URL Web App при этом остаётся прежним.

## 8. Доступ к Web App

В `src/appsscript.json` используется:

```json
"webapp": {
  "access": "ANYONE",
  "executeAs": "USER_ACCESSING"
}
```

Это означает:

- Web App открывается только пользователям, вошедшим в Google.
- Серверный код выполняется от имени текущего пользователя.
- Каждый пользователь должен один раз выдать приложению необходимые OAuth-разрешения.
- Пользователю необходим доступ к рабочей Google Spreadsheet и папке кандидатов в Google Drive.

Для корпоративного Google Workspace при необходимости можно ограничить запуск пользователями домена через `"access": "DOMAIN"`.

## 9. Разработка

Основные серверные файлы:

```text
src/
  Code.js
  Config.js
  Utils.js
  Candidates.js
  Interviews.js
  Vacancies.js
```

Frontend:

```text
src/
  Index.html
  Styles.html
  Scripts.html
```

### Полезные команды

```bash
npm run status
npm run push
npm run pull
npm run deployments
npm run open
```

## 10. Безопасность

В GitHub не должны попадать:

- `.clasprc.json`;
- `.clasp.json`;
- OAuth refresh tokens;
- Spreadsheet ID, если не хочешь публиковать структуру хранилища;
- Google Drive Folder ID;
- персональные данные кандидатов.

Данные кандидатов находятся только в Google Sheets / Google Drive.

## CI/CD

Проект рассчитан на актуальный clasp 3.x.

Для обновления существующего Web App workflow использует deployment ID, поэтому новый URL на каждый commit не создаётся.


## Версия 2: новые листы

### `Источники`

```text
Source ID
Название
Дата создания
Дата изменения
```

### `Ответственные`

```text
Responsible ID
ФИО
Email
User ID
Доступные этапы
Дата создания
Дата изменения
```

Поле `Доступные этапы` хранится в JSON и управляется из админ-панели.

### `Шаблоны интервью`

```text
Template ID
Название
Vacancy ID
Вакансия
Этап
Обязательный
Вопросы
Дата создания
Дата изменения
```

Шаблон выбирается по паре `Vacancy ID + текущий этап кандидата`.
Если шаблон помечен как `Обязательный`, он автоматически выбирается при переходе,
а переход запрещён до заполнения всех вопросов. Для одной пары
`Vacancy ID + Этап` допускается не более одного обязательного шаблона.

Назначения кандидата:

- `Responsible ID / Ответственный` — рекрутер; в UI отображается как «Рекрутер» и должен иметь доступ ко всем этапам pipeline.
- `HR Responsible ID / Ответственный HR` — обязательный ответственный с доступом к `HR screening`.
- `Tech Interviewer ID / Ответственный тех. интервьювер` — обязательный ответственный с доступом к `Техническое интервью`.


### Загрузка резюме

Web App принимает PDF/DOC/DOCX. Текущий лимит приложения — 10 МБ. При первом сохранении кандидата создаётся папка:

```text
<ФИО> - <8-символьный уникальный номер>
```

и резюме сохраняется непосредственно в неё.

> После обновления существующей установки обязательно выполнить `setupApplication()` или один раз открыть Web App, чтобы новые листы и колонки были созданы.


## Resume Intake API

Для интеграции с AI/ChatGPT подготовлен отдельный API-only Apps Script проект в `api-src/`.

Он создаёт предзаполненные черновики кандидатов, но не создаёт кандидата без подтверждения пользователя.

Документация:

`docs/API.md`

Skill:

`skills/recruiting-ats-resume/SKILL.md`

OpenAPI:

`skills/recruiting-ats-resume/openapi.yaml`

Для CI/CD API используются `API_CLASP_JSON`, `API_GAS_DEPLOYMENT_ID` и Repository Variable `API_WEB_APP_URL`.


## Google-авторизация и пользователи

Web App разворачивается с:

```json
{
  "access": "ANYONE",
  "executeAs": "USER_ACCESSING"
}
```

Приложение открывается только пользователям, вошедшим в Google, а серверный код
выполняется от имени текущего пользователя. Для идентификации используется
`ScriptApp.getIdentityToken()`; в таблице `Пользователи` сохраняется claim
`sub` как стабильный идентификатор Google Account.

Так как приложение выполняется от имени пользователя, каждому пользователю необходимо
предоставить доступ к рабочей Google Spreadsheet и папке кандидатов в Google Drive.

### `Пользователи`

```text
User ID
Google Subject
Email
ФИО
Avatar URL
IsActive
Дата создания
Последний вход
```

### `Candidate Transition Status Log`

```text
Transition ID
Candidate ID
№ кандидата
ФИО
From Status
To Status
Responsible ID
Ответственный
Changed By User ID
Changed By
Changed By Email
Комментарий
Дата
```

Связь `Ответственные.User ID -> Пользователи.User ID` необязательная.
Один пользователь может быть привязан не более чем к одному ответственному.
