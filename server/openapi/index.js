// OpenAPI 3.1 всего HTTP API ATS для страницы Swagger (/api/docs).
// RPC-методы описаны по группам в ./rpc/*.js: каждый метод — отдельный путь /api/rpc/<имя>,
// тело { args }, ответ { result }. Тест test/openapi.test.js сверяет описания с rpcHandlers.
import { APP_CONFIG, config } from '../config.js';
import admin from './rpc/admin.js';
import candidates from './rpc/candidates.js';
import developer from './rpc/developer.js';
import notifications from './rpc/notifications.js';
import workflow from './rpc/workflow.js';

export const rpcDocs = { ...candidates, ...workflow, ...notifications, ...admin, ...developer };

// Методы чтения; остальные изменяют данные (x-ats-writes) — на production Swagger UI спрашивает подтверждение.
export const isReadOnlyRpc = name => /^(get|list|find|parse)[A-Z]/.test(name);

const WRITE_WARNING = '**Изменяет данные** от вашего имени — запрос из «Try it out» выполняется по-настоящему и пишется в журнал.';

const RPC_TAGS = [
  ['Старт и справочники', 'Загрузка приложения: текущий пользователь, справочники, доска кандидатов.'],
  ['Кандидаты', 'Карточка кандидата, сохранение, архив, черновики, разбор резюме, поиск дублей.'],
  ['Интервью и этапы', 'Перевод по этапам воронки, интервью и ответы на вопросы шаблонов.'],
  ['Жизненный цикл записей', 'Архив, корзина и восстановление любых записей.'],
  ['Журнал изменений', 'История изменений записи и откат значения поля.'],
  ['Комментарии', 'Лента комментариев кандидата и реакции.'],
  ['Главная и аналитика', '«Мой день», аналитика найма, сводка.'],
  ['Уведомления', 'Колокольчик, журнал уведомлений, настройки, подписка на кандидата.'],
  ['Интеграции профиля', 'Подключения MCP-клиентов, личные токены, привязка Telegram.'],
  ['Вакансии', 'Серверная таблица вакансий, сохранение и статус.'],
  ['Источники', 'Источники кандидатов.'],
  ['Шаблоны интервью', 'Шаблоны вопросов для этапов.'],
  ['Пользователи', 'Пользователи ATS и доступ (администратор).'],
  ['Интеграции (админ)', 'Вход через Google, SMTP, Telegram — настройки администратора.'],
  ['Для разработчиков', 'Версия сборки, ссылки на API и исходный код, подключение Claude, состояние интеграций.']
];

const OTHER_TAGS = [
  ['Сессия и вход', 'Вход через Google (или dev-вход), выход, поток событий, служебные эндпоинты.'],
  ['Файлы', 'Файлы резюме и иконки источников — отдаются только вошедшим пользователям.'],
  ['Intake API', 'Внешний API для AI-интеграций: справочники и черновики кандидатов. Ключ `ATS_API_KEY`.'],
  ['MCP', 'MCP-сервер для Claude и других AI-клиентов (JSON-RPC 2.0, Streamable HTTP без сессий).'],
  ['OAuth 2.1', 'Авторизация MCP-клиентов: метаданные, регистрация, согласие, токены.']
];

const uuid = description => ({ type: 'string', format: 'uuid', description });

const errorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { error: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
        required: ['error']
      }
    }
  }
});

const intakeError = description => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean', const: false }, error: { type: 'string' } },
        required: ['ok', 'error']
      }
    }
  }
});

const oauthError = description => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { error: { type: 'string' }, error_description: { type: 'string' } },
        required: ['error']
      }
    }
  }
});

const html = description => ({ description, content: { 'text/html': { schema: { type: 'string' } } } });
const redirect = description => ({ description, headers: { Location: { schema: { type: 'string' } } } });
const json = (description, schema) => ({ description, content: { 'application/json': { schema } } });

const SESSION = [{ sessionCookie: [] }];
const INTAKE = [{ intakeApiKey: [] }, { intakeApiKeyQuery: [] }];
const MCP = [{ mcpBearer: [] }, { mcpPersonalToken: [] }];
const PUBLIC = [];

function rpcOperation(name, doc) {
  const requestSchema = {
    type: 'object',
    properties: doc.args ? { args: doc.args } : { args: { description: 'Не используется.' } }
  };

  if (doc.args) {
    requestSchema.required = ['args'];
  }

  const writes = !isReadOnlyRpc(name);
  const operation = {
    tags: [doc.tag],
    operationId: name,
    summary: doc.summary,
    description: writes ? `${WRITE_WARNING}

${doc.description}` : doc.description,
    'x-ats-writes': writes,
    security: SESSION,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: requestSchema,
          example: doc.args ? { args: doc.example === undefined ? null : doc.example } : {}
        }
      }
    },
    responses: {
      200: json('Успешный вызов.', {
        type: 'object',
        properties: { result: doc.result || { description: 'Результат метода.' } },
        required: ['result']
      }),
      400: errorResponse('Ошибка валидации или бизнес-правила (текст — для пользователя).'),
      401: errorResponse('Нет сессии: войдите в ATS.'),
      403: errorResponse('Недостаточно прав.'),
      404: errorResponse('Неизвестный метод или запись не найдена.'),
      415: errorResponse('Тело должно быть application/json.'),
      500: errorResponse('Внутренняя ошибка сервера (подробности — в логах).')
    }
  };

  return { post: operation };
}

const candidateDraftRequest = {
  type: 'object',
  description: 'Все поля необязательные. Полная проверка выполняется при сохранении формы кандидата.',
  properties: {
    action: { type: 'string', const: 'candidate-draft', description: 'Альтернатива query-параметру `api`.' },
    apiKey: { type: 'string', description: 'Альтернатива заголовку `X-API-Key` (не рекомендуется).' },
    lastName: { type: 'string', description: 'Фамилия' },
    firstName: { type: 'string', description: 'Имя' },
    middleName: { type: 'string', description: 'Отчество' },
    phone: { type: 'string', description: 'Телефон (в форме проверяется как мобильный номер РК)' },
    email: { type: 'string', description: 'Email (приводится к нижнему регистру)' },
    telegram: { type: 'string', description: 'Telegram username или ссылка' },
    github: { type: 'string' },
    linkedin: { type: 'string' },
    salary: { type: ['number', 'string'], description: 'Зарплатные ожидания' },
    vacancyId: uuid('ID вакансии из `api=references`'),
    sourceId: uuid('ID источника из `api=references`'),
    responsibleId: uuid('ID ответственного (пользователя) из `api=references`'),
    comment: { type: 'string', description: 'Станет первым комментарием в ленте кандидата после сохранения.' },
    links: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' } } }
    },
    resume: {
      type: 'object',
      description: `Файл резюме: ${APP_CONFIG.ALLOWED_RESUME_EXTENSIONS.join(', ')}, не больше 10 МБ. base64 — «чистый» или data URL.`,
      properties: {
        name: { type: 'string', example: 'cv.pdf' },
        mimeType: { type: 'string', example: 'application/pdf' },
        base64: { type: 'string', contentEncoding: 'base64' }
      },
      required: ['name', 'base64']
    }
  }
};

const jsonRpcMessage = {
  type: 'object',
  properties: {
    jsonrpc: { type: 'string', const: '2.0' },
    id: { type: ['integer', 'string', 'null'] },
    method: {
      type: 'string',
      enum: ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'prompts/list', 'notifications/initialized']
    },
    params: { type: 'object', additionalProperties: true }
  },
  required: ['jsonrpc', 'method']
};

function staticPaths() {
  const cookie = config.sessionCookieName;

  return {
    '/healthz': {
      get: {
        tags: ['Сессия и вход'],
        summary: 'Проверка живости (БД доступна)',
        security: PUBLIC,
        responses: {
          200: json('Сервер и БД работают.', { type: 'object', properties: { ok: { type: 'boolean', const: true } } }),
          503: json('БД недоступна.', { type: 'object', properties: { ok: { type: 'boolean', const: false } } })
        }
      }
    },
    '/auth/login': {
      get: {
        tags: ['Сессия и вход'],
        summary: 'Страница входа',
        description: config.auth.mode === 'dev' ? 'Режим `AUTH_MODE=dev`: форма входа по email.' : 'Кнопка «Войти через Google».',
        security: PUBLIC,
        parameters: [{ name: 'next', in: 'query', schema: { type: 'string' }, description: 'Путь внутри приложения для возврата после входа.' }],
        responses: { 200: html('HTML-страница входа.') }
      }
    },
    ...(config.auth.mode === 'dev'
      ? {
          '/auth/dev-login': {
            post: {
              tags: ['Сессия и вход'],
              summary: 'Dev-вход по email (только AUTH_MODE=dev)',
              security: PUBLIC,
              requestBody: {
                required: true,
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      properties: { email: { type: 'string', format: 'email' }, name: { type: 'string' }, next: { type: 'string' } },
                      required: ['email']
                    }
                  }
                }
              },
              responses: { 302: redirect(`Вход выполнен, установлена cookie \`${cookie}\`.`), 403: html('Доступ не открыт администратором.') }
            }
          }
        }
      : {
          '/auth/google': {
            get: {
              tags: ['Сессия и вход'],
              summary: 'Начать вход через Google (редирект на accounts.google.com)',
              security: PUBLIC,
              parameters: [{ name: 'next', in: 'query', schema: { type: 'string' } }],
              responses: { 302: redirect('Редирект на Google OAuth.') }
            }
          },
          '/auth/google/callback': {
            get: {
              tags: ['Сессия и вход'],
              summary: 'Callback Google OAuth: создаёт сессию',
              security: PUBLIC,
              parameters: [
                { name: 'code', in: 'query', schema: { type: 'string' } },
                { name: 'state', in: 'query', schema: { type: 'string' } }
              ],
              responses: {
                302: redirect(`Вход выполнен, установлена cookie \`${cookie}\`.`),
                401: html('Вход отменён или сессия входа устарела.'),
                403: html('Email не подтверждён или доступ не открыт.')
              }
            }
          }
        }),
    '/auth/logout': {
      post: {
        tags: ['Сессия и вход'],
        summary: 'Выход: удаляет сессию',
        security: SESSION,
        responses: { 302: redirect('Редирект на страницу входа.') }
      }
    },
    '/api/events': {
      get: {
        tags: ['Сессия и вход'],
        summary: 'Поток событий (Server-Sent Events)',
        description:
          'События `candidate` (data — id изменённого кандидата, из Postgres LISTEN/NOTIFY) и `resync` (перечитать доску после переподключения к БД). Heartbeat-комментарий каждые 25 с. В Swagger UI поток не завершится — проверяйте через `curl -N`.',
        security: SESSION,
        responses: {
          200: { description: 'Поток SSE.', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          401: errorResponse('Нет сессии.')
        }
      }
    },
    '/api/openapi.json': {
      get: {
        tags: ['Сессия и вход'],
        summary: 'Эта спецификация OpenAPI',
        security: SESSION,
        responses: { 200: json('OpenAPI 3.1.', { type: 'object' }), 401: errorResponse('Нет сессии.') }
      }
    },
    '/files/{id}': {
      get: {
        tags: ['Файлы'],
        summary: 'Скачать файл резюме (из Google Drive через сервер)',
        description: 'PDF отдаётся inline, остальное — attachment. Нативные документы Google и внешние ссылки — редирект.',
        security: SESSION,
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid('ID файла') }],
        responses: {
          200: { description: 'Содержимое файла.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          302: redirect('Редирект на Google Docs или внешнюю ссылку; без сессии — на страницу входа.'),
          404: { description: 'Файл не найден (в БД, в Drive или в корзине Drive).' }
        }
      }
    },
    '/candidates/{id}/files': {
      get: {
        tags: ['Файлы'],
        summary: 'HTML-список всех версий резюме кандидата',
        security: SESSION,
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid('ID кандидата') }],
        responses: { 200: html('Страница со списком файлов.'), 404: { description: 'Кандидат не найден.' } }
      }
    },
    '/source-icons/{id}': {
      get: {
        tags: ['Файлы'],
        summary: 'Иконка источника (PNG 64×64)',
        security: SESSION,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: uuid('ID источника') },
          { name: 'v', in: 'query', schema: { type: 'string' }, description: 'Версия (время изменения) для кэша.' }
        ],
        responses: {
          200: { description: 'PNG.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'Иконка не найдена.' }
        }
      }
    },
    '/intake': {
      get: {
        tags: ['Intake API'],
        operationId: 'intakeGet',
        summary: 'Проверка ключа (meta) или справочники (references)',
        description:
          '`api=meta` — `{ ok, webAppUrl }`. `api=references` — вакансии, источники и ответственные (без архивных и удалённых) для выбора ID черновика.',
        security: INTAKE,
        parameters: [{ name: 'api', in: 'query', required: true, schema: { type: 'string', enum: ['meta', 'references'] } }],
        responses: {
          200: json('Ответ action.', {
            type: 'object',
            properties: {
              ok: { type: 'boolean', const: true },
              webAppUrl: { type: 'string', format: 'uri' },
              vacancies: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: uuid('ID вакансии'), number: { type: 'integer' }, name: { type: 'string' }, status: { type: 'string' } }
                }
              },
              sources: {
                type: 'array',
                items: { type: 'object', properties: { id: uuid('ID источника'), number: { type: 'integer' }, name: { type: 'string' } } }
              },
              responsibles: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: uuid('ID пользователя'),
                    lastName: { type: 'string' },
                    firstName: { type: 'string' },
                    middleName: { type: 'string' },
                    fullName: { type: 'string' },
                    stages: { type: 'array', items: { type: 'string' }, description: 'Этапы, за которые отвечает.' }
                  }
                }
              }
            },
            required: ['ok']
          }),
          400: intakeError('Неизвестный action.'),
          401: intakeError('Ключ не передан или неверен.'),
          503: intakeError('На сервере не задан ATS_API_KEY.')
        }
      },
      post: {
        tags: ['Intake API'],
        operationId: 'intakeCreateCandidateDraft',
        'x-ats-writes': true,
        summary: 'Создать черновик кандидата (candidate-draft)',
        description:
          'Возвращает ссылку на форму нового кандидата с подставленными данными. Кандидат создаётся только после «Сохранить» в форме. Черновик живёт 7 дней. Тело до 15 МБ, разбирается как JSON при любом Content-Type.',
        security: INTAKE,
        parameters: [{ name: 'api', in: 'query', schema: { type: 'string', const: 'candidate-draft' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: candidateDraftRequest,
              example: { lastName: 'Петров', firstName: 'Сергей', email: 'petrov@example.com', comment: 'Распарсено из резюме' }
            }
          }
        },
        responses: {
          200: json('Черновик создан.', {
            type: 'object',
            properties: {
              ok: { type: 'boolean', const: true },
              draftToken: { type: 'string' },
              draftUrl: { type: 'string', format: 'uri', description: 'Форма кандидата с черновиком (нужен вход в ATS).' },
              webAppUrl: { type: 'string', format: 'uri' },
              expiresAt: { type: 'string', format: 'date-time' },
              resume: {
                type: ['object', 'null'],
                properties: { id: uuid('ID файла'), name: { type: 'string' }, url: { type: 'string', format: 'uri' } }
              }
            }
          }),
          400: intakeError('Неизвестный action, невалидный JSON или ошибка файла резюме.'),
          401: intakeError('Ключ не передан или неверен.'),
          413: intakeError('Тело больше 15 МБ.'),
          503: intakeError('На сервере не задан ATS_API_KEY.')
        }
      }
    },
    '/mcp': {
      post: {
        tags: ['MCP'],
        operationId: 'mcpJsonRpc',
        'x-ats-writes': true,
        summary: 'JSON-RPC 2.0: initialize, tools/list, tools/call…',
        description:
          'Одно сообщение или массив (batch). Уведомления (без `id`) → `202`. Инструменты выполняются от имени владельца токена; ошибки бизнес-правил возвращаются как результат с `isError: true`. Список инструментов — `tools/list`.',
        security: MCP,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { oneOf: [jsonRpcMessage, { type: 'array', items: jsonRpcMessage }] },
              examples: {
                toolsList: { summary: 'Список инструментов', value: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
                toolsCall: {
                  summary: 'Вызов инструмента',
                  value: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_references', arguments: {} } }
                }
              }
            }
          }
        },
        responses: {
          200: json('Ответ JSON-RPC.', { type: ['object', 'array'] }),
          202: { description: 'Только уведомления — ответа нет.' },
          401: {
            description: 'Нет или неверный токен. Заголовок `WWW-Authenticate` указывает на метаданные ресурса.',
            headers: { 'WWW-Authenticate': { schema: { type: 'string' } } }
          }
        }
      }
    },
    '/mcp/uploads/{token}': {
      post: {
        tags: ['MCP'],
        summary: 'Загрузить файл резюме по одноразовой ссылке (create_upload_link)',
        description: 'Ссылка живёт 30 минут, файл — сырое тело запроса. Токен в пути сам является авторизацией.',
        security: PUBLIC,
        parameters: [
          { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'query', required: true, schema: { type: 'string', example: 'cv.pdf' }, description: 'Имя файла: .pdf, .doc или .docx' }
        ],
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
        },
        responses: {
          200: json('Файл принят.', {
            type: 'object',
            properties: { ok: { type: 'boolean' }, uploadId: { type: 'string' }, name: { type: 'string' }, size: { type: 'integer' } }
          }),
          400: intakeError('Нет имени/недопустимое расширение или пустой файл.'),
          404: intakeError('Ссылка не найдена или истекла.'),
          413: intakeError('Больше 10 МБ.')
        }
      }
    },
    '/.well-known/oauth-protected-resource': {
      get: { tags: ['OAuth 2.1'], summary: 'Метаданные защищённого ресурса (RFC 9728)', security: PUBLIC, responses: { 200: json('Метаданные.', { type: 'object' }) } }
    },
    '/.well-known/oauth-authorization-server': {
      get: { tags: ['OAuth 2.1'], summary: 'Метаданные сервера авторизации (RFC 8414)', security: PUBLIC, responses: { 200: json('Метаданные.', { type: 'object' }) } }
    },
    '/.well-known/openid-configuration': {
      get: { tags: ['OAuth 2.1'], summary: 'То же в формате OpenID Discovery', security: PUBLIC, responses: { 200: json('Метаданные.', { type: 'object' }) } }
    },
    '/oauth/jwks': {
      get: { tags: ['OAuth 2.1'], summary: 'Пустой набор ключей (ID-токены не выдаются)', security: PUBLIC, responses: { 200: json('JWKS.', { type: 'object' }) } }
    },
    '/oauth/register': {
      post: {
        tags: ['OAuth 2.1'],
        summary: 'Динамическая регистрация публичного клиента (RFC 7591)',
        description: '`redirect_uris` — `https://…` или loopback `http://localhost|127.0.0.1|[::1]`. Не больше 20 регистраций в час с IP.',
        security: PUBLIC,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { client_name: { type: 'string' }, redirect_uris: { type: 'array', items: { type: 'string', format: 'uri' } } },
                required: ['redirect_uris']
              }
            }
          }
        },
        responses: {
          201: json('Клиент зарегистрирован.', { type: 'object', properties: { client_id: { type: 'string' } }, additionalProperties: true }),
          400: oauthError('Неверные метаданные клиента.'),
          429: oauthError('Слишком много регистраций.')
        }
      }
    },
    '/oauth/authorize': {
      get: {
        tags: ['OAuth 2.1'],
        summary: 'Страница согласия (нужна сессия ATS, PKCE S256 обязателен)',
        security: SESSION,
        parameters: ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope'].map(name => ({
          name,
          in: 'query',
          required: ['response_type', 'client_id', 'redirect_uri', 'code_challenge'].includes(name),
          schema: { type: 'string' }
        })),
        responses: { 200: html('Форма «Разрешить / Отмена».'), 302: redirect('Ошибка запроса → redirect_uri с error; без сессии → вход.') }
      },
      post: {
        tags: ['OAuth 2.1'],
        summary: 'Решение пользователя на странице согласия',
        security: SESSION,
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: { nonce: { type: 'string' }, decision: { type: 'string', enum: ['allow', 'deny'] } },
                required: ['nonce', 'decision']
              }
            }
          }
        },
        responses: { 302: redirect('Редирект на redirect_uri с `code` или `error=access_denied`.'), 400: html('Запрос устарел.') }
      }
    },
    '/oauth/token': {
      post: {
        tags: ['OAuth 2.1'],
        summary: 'Выдача токенов: authorization_code и refresh_token',
        description: 'Access-токен живёт 1 час, refresh — 90 дней с ротацией. Код одноразовый, 10 минут.',
        security: PUBLIC,
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  grant_type: { type: 'string', enum: ['authorization_code', 'refresh_token'] },
                  code: { type: 'string' },
                  redirect_uri: { type: 'string' },
                  code_verifier: { type: 'string' },
                  client_id: { type: 'string' },
                  refresh_token: { type: 'string' }
                },
                required: ['grant_type']
              }
            }
          }
        },
        responses: {
          200: json('Токены.', {
            type: 'object',
            properties: {
              access_token: { type: 'string' },
              token_type: { type: 'string', const: 'Bearer' },
              expires_in: { type: 'integer' },
              refresh_token: { type: 'string' },
              scope: { type: 'string' }
            }
          }),
          400: oauthError('invalid_grant, invalid_request, unsupported_grant_type…')
        }
      }
    },
    '/oauth/revoke': {
      post: {
        tags: ['OAuth 2.1'],
        summary: 'Отзыв токена (RFC 7009)',
        security: PUBLIC,
        requestBody: {
          required: true,
          content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } } }
        },
        responses: { 200: { description: 'Отозван (или токен не найден).' } }
      }
    },
    '/privacy': {
      get: { tags: ['Сессия и вход'], summary: 'Политика конфиденциальности', security: PUBLIC, responses: { 200: html('HTML.') } }
    }
  };
}

const DESCRIPTION = `Полное HTTP API Recruiting ATS.

**Авторизация.** Внутренний RPC (\`/api/rpc/<метод>\`), файлы и поток событий работают по cookie-сессии \`${config.sessionCookieName}\`:
раз вы открыли эту страницу, вы уже вошли, и «Try it out» отправляет запросы от вашего имени с вашими правами.
Все изменения пишутся в журнал ATS — на рабочей базе вызывайте методы записи осознанно.

Для Intake API введите ключ \`ATS_API_KEY\` в **Authorize** (intakeApiKey), для MCP — OAuth access-токен или личный токен из профиля (mcpBearer / mcpPersonalToken).

**RPC.** Каждый метод — \`POST /api/rpc/<имя>\` с телом \`{ "args": … }\` и ответом \`{ "result": … }\`;
ошибка — \`{ "error": { "message": "…" } }\` со статусом 4xx/5xx. Методы с пометкой «администратор» проверяют роль на сервере.`;

export function buildOpenApiSpec() {
  const rpcPaths = Object.fromEntries(
    Object.entries(rpcDocs).map(([name, doc]) => [`/api/rpc/${name}`, rpcOperation(name, doc)])
  );
  const otherPaths = staticPaths();

  // operationId нужен Swagger UI для ссылок на операцию: get /oauth/token → getOauthToken.
  for (const [path, item] of Object.entries(otherPaths)) {
    for (const [method, operation] of Object.entries(item)) {
      operation.operationId ||= method + path.replace(/[{}]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
        .map(part => part[0].toUpperCase() + part.slice(1)).join('');
    }
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Recruiting ATS API', version: '2.0.0', description: DESCRIPTION },
    // Путь без origin: запросы уходят на тот же хост, с которого открыт Swagger (cookie сессии доступна).
    servers: [{ url: config.basePath || '/', description: 'Этот сервер' }],
    tags: [...RPC_TAGS, ...OTHER_TAGS].map(([name, description]) => ({ name, description })),
    security: SESSION,
    paths: { ...rpcPaths, ...otherPaths },
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: config.sessionCookieName,
          description: 'Cookie сессии после входа в ATS. Браузер отправляет её сам — вводить ничего не нужно.'
        },
        intakeApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Ключ Intake API (ATS_API_KEY).' },
        intakeApiKeyQuery: {
          type: 'apiKey',
          in: 'query',
          name: 'api_key',
          description: 'Тот же ключ в query — для клиентов без заголовков (попадает в логи прокси).'
        },
        mcpBearer: { type: 'http', scheme: 'bearer', description: 'OAuth access-токен MCP или личный токен `atsp_…`.' },
        mcpPersonalToken: { type: 'apiKey', in: 'header', name: 'X-ATS-Token', description: 'Личный токен из «Профиль → ИИ-ассистенты».' }
      }
    }
  };
}
