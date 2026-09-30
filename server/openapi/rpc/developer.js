// OpenAPI-описание RPC-методов: для разработчиков.
const statusItem = {
  type: 'object',
  properties: {
    key: { type: 'string', enum: ['database', 'drive', 'telegram', 'smtp', 'auth', 'intake'] },
    label: { type: 'string', description: 'Название для интерфейса.' },
    state: {
      type: 'string',
      enum: ['ok', 'off', 'warn', 'error'],
      description: 'ok — работает, off — не настроено, warn — требует внимания (например, dev-вход), error — ошибка.'
    },
    detail: { type: 'string', description: 'Пояснение: имя папки Drive, бот, текст ошибки…' }
  },
  required: ['key', 'label', 'state', 'detail']
};

export default {
  getDeveloperInfo: {
    tag: 'Для разработчиков',
    summary: 'Версия сборки, ссылки на API и код, подключение Claude и Intake',
    description:
      'Данные вкладки «Настройки → Для разработчиков». Коммит читается из git при первом вызове ' +
      '(в Docker — из `BUILD_COMMIT`), `startedAt` — время запуска процесса.\n\n' +
      '`status` — только для администраторов (остальным `null`): вызов проверяет PostgreSQL и доступ к папке ' +
      'Google Drive (до 5 с), остальное берёт из настроек. Ничего не изменяет.',
    args: null,
    result: {
      type: 'object',
      properties: {
        version: {
          type: 'object',
          properties: {
            commit: { type: 'string', description: 'Полный хеш коммита; пусто, если неизвестен.' },
            commitShort: { type: 'string' },
            commitDate: { type: 'string', description: 'Дата коммита в часовом поясе приложения.' },
            commitSubject: { type: 'string' },
            commitUrl: { type: 'string', description: 'Ссылка на коммит в репозитории.' },
            startedAt: { type: 'string', description: 'Запуск процесса (≈ время деплоя).' },
            node: { type: 'string', example: 'v22.12.0' },
            env: { type: 'string', example: 'production' }
          }
        },
        links: {
          type: 'object',
          properties: {
            swagger: { type: 'string' },
            openApi: { type: 'string' },
            repository: { type: 'string', format: 'uri' },
            apiGuide: { type: 'string', description: 'docs/API.md в репозитории.' }
          }
        },
        mcp: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            addCommand: { type: 'string', description: 'Подключение в Claude Code через OAuth.' },
            addCommandWithToken: { type: 'string', description: 'Подключение с личным токеном из профиля.' }
          }
        },
        intake: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            configured: { type: 'boolean', description: 'Задан ли ATS_API_KEY (сам ключ не возвращается).' }
          }
        },
        status: { type: ['array', 'null'], items: statusItem }
      },
      required: ['version', 'links', 'mcp', 'intake', 'status']
    }
  }
};
