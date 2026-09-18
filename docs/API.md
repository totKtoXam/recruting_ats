# Recruiting ATS API

API работает через тот же Google Apps Script Web App.

## Настройка

Один раз открой Apps Script и выполни функцию:

```text
setupApiAccess
```

Она вернёт:

```json
{
  "apiKey": "ats_...",
  "webAppUrl": "https://script.google.com/macros/s/.../exec"
}
```

`apiKey` храни как секрет интеграции. URL Web App секретом не является.

## Получить справочники

```http
GET {WEB_APP_URL}?api=references&api_key={ATS_API_KEY}
```

Возвращаются активные вакансии, источники и ответственные. Это позволяет агенту не угадывать ID.

## Создать предзаполненный черновик кандидата

```http
POST {WEB_APP_URL}?api=candidate-draft&api_key={ATS_API_KEY}
Content-Type: application/json
```

Пример:

```json
{
  "lastName": "Иванов",
  "firstName": "Иван",
  "middleName": "Иванович",
  "phone": "+7 777 123 45 67",
  "email": "ivan@example.com",
  "telegram": "@ivan",
  "github": "ivan-dev",
  "linkedin": "ivan-ivanov",
  "salary": 800000,
  "vacancyId": "",
  "sourceId": "",
  "responsibleId": "",
  "comment": "Данные извлечены из резюме",
  "links": [
    {
      "name": "Portfolio",
      "url": "https://example.com"
    }
  ],
  "resume": {
    "name": "Ivanov_Ivan.pdf",
    "mimeType": "application/pdf",
    "base64": "JVBERi0xLjc..."
  }
}
```

Ответ:

```json
{
  "ok": true,
  "draftToken": "...",
  "draftUrl": "https://script.google.com/macros/s/.../exec?draft=...",
  "webAppUrl": "https://script.google.com/macros/s/.../exec",
  "expiresAt": "..."
}
```

Пользователь открывает `draftUrl` и получает форму нового кандидата с предзаполненными данными. Резюме из API переносится в папку кандидата только после подтверждения и сохранения формы.

Черновик живёт 7 дней и после успешного создания кандидата помечается использованным.

## Очистка старых черновиков

При необходимости вручную или по trigger:

```text
cleanupExpiredCandidateDrafts
```

## Безопасность

- API key хранится только в Script Properties / секрете интеграции.
- Не коммить API key в GitHub.
- API не создаёт кандидата автоматически: он создаёт только черновик.
- Пользователь должен открыть ссылку, проверить данные и нажать «Сохранить».
