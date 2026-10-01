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
- `scripts/ats-mcp-stdio.mjs` — мост между stdio MCP и прежним HTTP endpoint ATS.
- `scripts/start-tunnel.ps1` — проверка настроек и запуск OpenAI Secure MCP Tunnel
  на Windows. Туннель нужен для приватного приложения ChatGPT; для локального
  Codex используется `mcp.json`.

## Подключение ChatGPT

1. В ATS откройте «Профиль → ИИ-ассистенты» и создайте личный MCP-токен.
2. В OpenAI Platform создайте туннель, связанный с нужным ChatGPT workspace, и
   runtime API key с правом Tunnels Read + Use. ID туннеля и ключи не храните в
   репозитории.
3. Установите Node.js 22+ и официальный
   [tunnel-client](https://github.com/openai/tunnel-client/releases/latest).
   В приватной сессии PowerShell запустите
   `scripts/start-tunnel.ps1 -TunnelId <ваш tunnel_id>`. Если
   `CONTROL_PLANE_API_KEY` и `ATS_MCP_TOKEN` ещё не заданы в окружении,
   скрипт запросит их без отображения на экране. Оставьте процесс работающим.
4. Владелец пакета создал приватное приложение ChatGPT **Recruiting ATS MCP**
   с типом подключения **Tunnel** и привязал его проверенный ID в `.app.json`.
   При установке пакета в своём аккаунте подключите приложение и проверьте
   запрос только на чтение. Доступ к этому личному приложению зависит от
   аккаунта и не распространяется на других пользователей репозитория.

Локальное подключение через `mcp.json` предназначено для клиента, который
запускает stdio-процесс и передаёт ему `ATS_MCP_TOKEN`.

Токен ATS даёт доступ с правами своего владельца; приложение должно оставаться
приватным для этого пользователя. MCP-запросы и ответы проходят через OpenAI
Secure MCP Tunnel, а токен ATS передаётся только от локального моста к ATS.
