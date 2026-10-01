# Recruiting ATS для ChatGPT и Codex

Пакет Agent Plugins 1.0 переносит пять навыков из `plugins/recruiting-ats` и
подключается к действующему `https://portal.devexpert.kz/hr-ats/mcp`. Сервер ATS и
его хостинг не меняются. Локальный мост использует личный токен ATS в
`Authorization: Bearer`; запросы к `/.well-known/*` ему не нужны.

## Состав

- `plugin.json`, `mcp.json` — переносимый манифест и локальное MCP-подключение.
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
4. В ChatGPT Developer mode создайте **приватное приложение**, выберите
   **Tunnel** и созданный туннель. Проверьте `tools/list` и безопасный запрос
   только на чтение. После создания приложения его ID вида `plugin_asdk_app…`
   добавляется в `.app.json`, а путь `./.app.json` — в
   `plugin.json → extensions.com.openai.apps`. Не подставляйте вымышленный ID.

Пока реальный ID приложения не добавлен, навыки в пакете готовы, а инструменты
ChatGPT через туннель **не привязаны к пакету автоматически**. Локальное
подключение через `mcp.json` предназначено для клиента, который запускает
stdio-процесс и передаёт ему `ATS_MCP_TOKEN`.

Токен ATS даёт доступ с правами своего владельца; приложение должно оставаться
приватным для этого пользователя. MCP-запросы и ответы проходят через OpenAI
Secure MCP Tunnel, а токен ATS передаётся только от локального моста к ATS.
