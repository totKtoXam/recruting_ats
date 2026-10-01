# Recruiting ATS для ChatGPT и Codex

Пакет Agent Plugins 1.0 переносит пять навыков из `plugins/recruiting-ats` и
подключается к действующему `https://portal.devexpert.kz/hr-ats/mcp`. Сервер ATS и
его хостинг не меняются. Локальный мост использует личный токен ATS в
`Authorization: Bearer`; запросы к `/.well-known/*` ему не нужны.

## Состав

- `plugin.json`, `mcp.json` — переносимый манифест и локальное MCP-подключение.
- `.app.json` — привязка к проверенному приватному приложению ChatGPT.
- `skills/` — навыки для ATS, проектирования интервью, HR-скрининга,
  технического интервью .NET и разбора результатов.
- `scripts/ats-mcp-stdio.mjs` — мост между stdio MCP и прежним HTTP endpoint ATS
  для локальных клиентов `mcp.json`. `ATS_MCP_URL` переопределяет адрес ATS.
- `scripts/start-tunnel.ps1` — проверка настроек и запуск OpenAI Secure MCP Tunnel
  на Windows с прямым HTTP-подключением к ATS. Туннель нужен для приватного
  приложения ChatGPT; для локального Codex используется `mcp.json`.
- `scripts/recruiting-ats-tunnel.service` — пример постоянной службы Linux.

## Подключение ChatGPT

1. В ATS откройте «Профиль → ИИ-ассистенты» и создайте личный MCP-токен.
2. В OpenAI Platform создайте туннель, связанный с нужным ChatGPT workspace, и
   runtime API key с правом Tunnels Read + Use. ID туннеля и ключи не храните в
   репозитории.
3. Установите официальный
   [tunnel-client](https://github.com/openai/tunnel-client/releases/latest).
   В приватной сессии PowerShell запустите
   `scripts/start-tunnel.ps1 -TunnelId <ваш tunnel_id>`. Если
   `CONTROL_PLANE_API_KEY` и `ATS_MCP_TOKEN` ещё не заданы в окружении,
   скрипт запросит их без отображения на экране. Установите `ATS_MCP_URL` перед
   запуском, если ATS доступен по другому адресу. Сертификат HTTPS должен быть
   доверенным на этом компьютере. Оставьте процесс работающим.
4. Владелец пакета создал приватное приложение ChatGPT **Recruiting ATS MCP**
   с типом подключения **Tunnel** и привязал его проверенный ID в `.app.json`.
   При установке пакета в своём аккаунте подключите приложение и проверьте
   запрос только на чтение. Доступ к этому личному приложению зависит от
   аккаунта и не распространяется на других пользователей репозитория.

Локальное подключение через `mcp.json` предназначено для клиента, который
запускает stdio-процесс и передаёт ему `ATS_MCP_TOKEN`.

## Постоянный запуск на сервере Linux

На постоянно работающем сервере установите официальный `tunnel-client` и
скопируйте unit-файл `recruiting-ats-tunnel.service` в `/etc/systemd/system/`.
Используйте прямое HTTP-подключение к локальному ATS. Stdio-режим
`tunnel-client` требует отдельного MCP handshake от вызывающего клиента и
может отклонить вызовы инструментов ChatGPT до инициализации.
Служба запускается от отдельного пользователя `recruiting-ats-tunnel`.
Файл `/etc/recruiting-ats-tunnel/credentials.env` должен принадлежать root и
иметь права `0600`; он содержит:

```ini
CONTROL_PLANE_TUNNEL_ID=<существующий tunnel_id>
CONTROL_PLANE_API_KEY=<runtime API key OpenAI с Tunnels Read и Use>
ATS_AUTHORIZATION="Bearer <личный токен ATS>"
MCP_SERVER_URL=http://127.0.0.1:3040/hr-ats/mcp
MCP_EXTRA_HEADERS="Authorization: env:ATS_AUTHORIZATION"
```

Используйте loopback-адрес `MCP_SERVER_URL` только если ATS работает на этом же
сервере; иначе укажите проверенный приватный HTTPS-адрес. Статический заголовок
`Authorization` применяется только к MCP-серверу и не передаётся в control plane.
После `systemctl daemon-reload` и `systemctl enable --now
recruiting-ats-tunnel` проверьте `http://127.0.0.1:18080/readyz` и вызов
инструмента только на чтение в ChatGPT. При переносе действующего туннеля
остановите прежний локальный клиент после проверки серверного.

Токен ATS даёт доступ с правами своего владельца; приложение должно оставаться
приватным для этого пользователя. MCP-запросы и ответы проходят через OpenAI
Secure MCP Tunnel, а токен ATS передаётся в `Authorization` только от
`tunnel-client` к ATS.
