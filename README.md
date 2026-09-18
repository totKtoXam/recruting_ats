# Recruiting ATS

Лёгкая ATS (Applicant Tracking System) на Google Apps Script.

Данные хранятся в Google Sheets, файлы кандидатов — в Google Drive, а пользователи работают через Web App.

## Возможности

- Kanban по этапам найма с drag & drop, фильтрами и сворачиваемыми колонками.
- Админ-панель: CRUD вакансий, источников, ответственных и шаблонов интервью.
- Ответственные ограничиваются доступными этапами найма.
- Карточка кандидата с обязательными ФИО, вакансией, телефоном, ответственным и резюме.
- ФЛК мобильного номера Казахстана и email.
- Telegram username автоматически преобразуется в кликабельную ссылку.
- Загрузка PDF/DOC/DOCX резюме в персональную папку кандидата в Google Drive.
- Произвольные дополнительные ссылки кандидата.
- Управляемый pipeline: Новый ↔ HR screening ↔ Техническое интервью ↔ Финальное интервью ↔ Offer ↔ Hired.
- При каждом переходе между этапами запрашивается результат этапа/интервью.
- Шаблон вопросов автоматически подбирается по вакансии и текущему этапу.
- История результатов интервью доступна для просмотра и редактирования.
- Архивирование переводит кандидата в «Отказ» с причиной «Архивация».
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

Либо просто открой задеплоенный Web App: `doGet()` также вызывает проверку схемы.

Автоматически поддерживаются листы:

```text
Кандидаты
Интервью
Вакансии
Источники
Ответственные
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

Переход в архив доступен отдельно из любого активного этапа и устанавливает:

```text
Статус = Отказ
Архивирован = true
Причина отказа = Архивация
```

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
Ответственный
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

По умолчанию в `src/appsscript.json` используется:

```json
"webapp": {
  "access": "ANYONE",
  "executeAs": "USER_DEPLOYING"
}
```

Это означает:

- Web App выполняется от имени пользователя, который его задеплоил.
- Открыть его может любой пользователь, вошедший в Google.

Если используется корпоративный Google Workspace, для внутренней ATS рекомендуется заменить:

```json
"access": "DOMAIN"
```

Тогда Web App будет доступен только пользователям домена.

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
Вопросы
Дата создания
Дата изменения
```

Шаблон выбирается автоматически по паре `Vacancy ID + текущий этап кандидата`.

### Загрузка резюме

Web App принимает PDF/DOC/DOCX. Текущий лимит приложения — 10 МБ. При первом сохранении кандидата создаётся папка:

```text
<ФИО> - <8-символьный уникальный номер>
```

и резюме сохраняется непосредственно в неё.

> После обновления существующей установки обязательно выполнить `setupApplication()` или один раз открыть Web App, чтобы новые листы и колонки были созданы.
