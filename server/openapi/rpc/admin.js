// OpenAPI-описание RPC-методов: администрирование (вакансии, шаблоны вакансий, источники, шаблоны интервью,
// пользователи, интеграции).

const PIPELINE_STAGES = ['Новый', 'HR screening', 'Проф. интервью', 'Финальное интервью', 'Offer', 'Hired'];
const VACANCY_STATUSES = ['Открыта', 'На паузе', 'Закрыта'];
const TAG_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'gray'];
const SOURCE_ICON_KEYS = [
  'linkedin', 'github', 'telegram', 'instagram', 'facebook', 'whatsapp', 'hh', 'habr', 'djinni',
  'enbek', 'olx', 'indeed', 'glassdoor', 'superjob', 'jooble', 'vk', 'youtube', 'x',
  'website', 'referral', 'direct', 'internal', 'agency', 'event', 'other'
];
const INTEGRATION_GROUPS = ['auth', 'smtp', 'telegram'];
const INTEGRATION_KEYS = [
  'auth.googleClientId', 'auth.googleClientSecret', 'auth.allowedDomains', 'auth.allowedEmails',
  'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass', 'smtp.from',
  'telegram.botToken', 'telegram.polling'
];

const DATE_TIME = 'Дата и время «yyyy-MM-dd HH:mm:ss» в часовом поясе приложения; пустая строка — нет значения';
const uuid = description => ({ type: 'string', format: 'uuid', description });
const dateTime = description => ({ type: 'string', description: `${description}. ${DATE_TIME}` });

// Поля состояния записи (lifecycleFields).
const LIFECYCLE_PROPS = {
  state: { type: 'string', enum: ['active', 'archived', 'deleted'], description: 'Состояние: активна, в архиве, в корзине' },
  archivedAt: dateTime('Когда перенесена в архив'),
  deletedAt: dateTime('Когда перенесена в корзину'),
  purgeAt: dateTime('Когда будет окончательно удалена из корзины'),
  daysUntilPurge: { type: ['integer', 'null'], description: 'Дней до окончательного удаления; null — не в корзине' }
};

const SOFT_DELETE_PROPS = {
  'Дата создания': dateTime('Дата создания'),
  'Дата изменения': dateTime('Дата изменения'),
  ...LIFECYCLE_PROPS
};

const VACANCY_LINK = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Ссылка на публикацию (http:// или https://)' },
    name: { type: 'string', description: 'Подпись ссылки (до 120 символов)' }
  }
};

const VACANCY = {
  type: 'object',
  description: 'Вакансия',
  properties: {
    'Vacancy ID': uuid('ID вакансии'),
    '№': { type: 'integer', description: 'Порядковый номер' },
    'Вакансия': { type: 'string', description: 'Название' },
    'Статус': { type: 'string', enum: VACANCY_STATUSES, description: 'Статус вакансии' },
    links: { type: 'array', items: VACANCY_LINK, description: 'Ссылки на публикации' },
    requiredStages: {
      type: 'array',
      items: { type: 'string', enum: PIPELINE_STAGES },
      description: 'Обязательные этапы: при переходе нужен итог (и ответы, если привязан шаблон)'
    },
    presetId: { type: 'string', description: 'ID шаблона вакансии, из которого вакансия создана; пустая строка — не из шаблона' },
    ...SOFT_DELETE_PROPS
  }
};

// Этап во входных данных (saveVacancy.templates, saveVacancyPreset.templates).
const STAGE_INPUT = {
  type: 'object',
  required: ['stage'],
  properties: {
    stage: { type: 'string', enum: PIPELINE_STAGES, description: 'Этап воронки' },
    templateId: uuid('ID шаблона интервью; пусто — без шаблона'),
    required: { type: ['boolean', 'string'], default: false, description: 'Обязательный этап: при переходе нужен итог (и ответы, если есть шаблон). Принимается true или "true"' }
  }
};

// Шаблон интервью на этапе (в ответах таблиц вакансий и шаблонов вакансий).
const STAGE_TEMPLATE = {
  type: 'object',
  properties: {
    id: uuid('ID шаблона'),
    number: { type: 'integer', description: 'Номер шаблона' },
    name: { type: 'string', description: 'Название шаблона' },
    stage: { type: 'string', enum: PIPELINE_STAGES, description: 'Этап' },
    required: { type: 'boolean', description: 'Обязательный этап' },
    archived: { type: 'boolean', description: 'Шаблон в архиве' }
  }
};

// Этап шаблона вакансии, который не перенёсся: его шаблон интервью в архиве или в корзине.
const SKIPPED_STAGES = {
  type: 'array',
  description: 'Этапы, на которых шаблон интервью в архиве или в корзине: этап скопирован без шаблона (обязательность сохранена)',
  items: {
    type: 'object',
    properties: {
      stage: { type: 'string', enum: PIPELINE_STAGES, description: 'Этап' },
      number: { type: 'integer', description: 'Номер шаблона интервью' },
      name: { type: 'string', description: 'Название шаблона интервью' }
    }
  }
};

const VACANCY_PRESET = {
  type: 'object',
  description: 'Шаблон вакансии: этапы — шаблон интервью и обязательность на каждом этапе',
  properties: {
    'Preset ID': uuid('ID шаблона вакансии'),
    '№': { type: 'integer', description: 'Порядковый номер' },
    'Название': { type: 'string', description: 'Название шаблона вакансии' },
    requiredStages: {
      type: 'array',
      items: { type: 'string', enum: PIPELINE_STAGES },
      description: 'Обязательные этапы: при переходе нужен итог (и ответы, если на этапе есть шаблон интервью)'
    },
    templates: {
      type: 'array',
      items: STAGE_TEMPLATE,
      description: 'Шаблоны интервью на этапах (в порядке воронки), без шаблонов в корзине'
    },
    vacancyCount: { type: 'integer', description: 'Сколько вакансий (не в корзине) создано из шаблона' },
    ...SOFT_DELETE_PROPS
  }
};

const SOURCE = {
  type: 'object',
  description: 'Источник кандидатов',
  properties: {
    'Source ID': uuid('ID источника'),
    '№': { type: 'integer', description: 'Порядковый номер' },
    'Название': { type: 'string', description: 'Название источника' },
    iconKey: { type: 'string', description: 'Ключ пресета иконки; пустая строка — определить по названию' },
    iconUrl: { type: 'string', description: 'URL своей PNG-иконки (/source-icons/:id?v=…); пустая строка — своей нет' },
    ...SOFT_DELETE_PROPS
  }
};

const TEMPLATE_QUESTION = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Текст вопроса' },
    answers: { type: 'array', items: { type: 'string' }, description: 'Вероятные (предпочтительные) ответы' }
  }
};

const TEMPLATE_TAG = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Название тега (до 40 символов)' },
    color: { type: 'string', enum: TAG_COLORS, description: 'Цвет тега' }
  }
};

const TEMPLATE_PROPS = {
  'Template ID': uuid('ID шаблона'),
  '№': { type: 'integer', description: 'Порядковый номер' },
  'Название': { type: 'string', description: 'Название шаблона' },
  'Вопросы': { type: 'string', description: 'Вопросы в виде JSON-строки (то же, что questions)' },
  questions: { type: 'array', items: TEMPLATE_QUESTION, description: 'Вопросы шаблона' },
  tags: { type: 'array', items: TEMPLATE_TAG, description: 'Теги шаблона' },
  usage: { type: 'integer', description: 'Сколько вакансий (не в корзине) используют шаблон' },
  presetUsage: { type: 'integer', description: 'Сколько шаблонов вакансий (не в корзине) используют шаблон' },
  ...SOFT_DELETE_PROPS
};

const USER_PROPS = {
  'User ID': uuid('ID пользователя'),
  'Email': { type: 'string', description: 'Email Google Account' },
  'ФИО': { type: 'string', description: 'ФИО (или full_name / email, если ФИО пусто)' },
  'Фамилия': { type: 'string' },
  'Имя': { type: 'string' },
  'Отчество': { type: 'string' },
  stages: { type: 'array', items: { type: 'string', enum: PIPELINE_STAGES }, description: 'Этапы, за которые отвечает пользователь' },
  telegram: { type: 'string', description: 'Ник Telegram с «@»; пустая строка — не указан' },
  telegramVerified: { type: 'boolean', description: 'Telegram подтверждён привязкой через бота' },
  emailEditable: { type: 'boolean', description: 'Email можно исправить (пользователь ещё ни разу не входил)' },
  ...LIFECYCLE_PROPS,
  'Avatar URL': { type: 'string', description: 'URL аватара из Google; пустая строка — нет' },
  'IsActive': { type: 'boolean', description: 'Доступ в ATS открыт' },
  isAdmin: { type: 'boolean', description: 'Права администратора' },
  accessStatus: { type: 'string', enum: ['active', 'pending', 'disabled'], description: 'active — доступ открыт, pending — ещё не выдавался, disabled — выдан и отозван' },
  'Статус доступа': { type: 'string', enum: ['Доступ открыт', 'Ожидает доступа', 'Доступ отключён'], description: 'Подпись статуса доступа' },
  'Последний вход': dateTime('Последний вход'),
  'Доступ выдан': dateTime('Когда выдан доступ'),
  'Запрос доступа': dateTime('Когда пользователь запросил доступ'),
  'Добавлен': dateTime('Когда пользователь добавлен')
};

const USER = { type: 'object', description: 'Пользователь (toPublicUser)', properties: USER_PROPS };

// ---------- Серверные таблицы (list*) ----------

const listArgs = ({ filters, sortKeys, defaultSort }) => ({
  type: 'object',
  description: 'Параметры таблицы. Неизвестные ключи фильтров и сортировки молча игнорируются.',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1, description: 'Номер страницы; больше последней — вернётся последняя' },
    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Размер страницы (ограничивается диапазоном 1–100)' },
    sort: {
      type: 'object',
      description: `Сортировка; неизвестный key — сортировка по умолчанию (${defaultSort}). NULL — в конце.`,
      properties: {
        key: { type: 'string', enum: sortKeys, description: 'Поле сортировки' },
        dir: { type: 'string', enum: ['asc', 'desc'], default: 'asc', description: 'Направление; всё, кроме «desc», — по возрастанию' }
      }
    },
    filters: {
      type: 'object',
      description: 'Фильтры (объединяются по AND); пустые значения пропускаются',
      properties: {
        state: {
          type: 'string',
          enum: ['active', 'archived', 'deleted', 'all'],
          default: 'active',
          description: 'Состояние записей. «deleted» (корзина) — только для администраторов, иначе заменяется на «active»; «all» для не-администраторов — без корзины'
        },
        ...filters
      }
    }
  }
});

const listResult = (item, sortKeys) => ({
  type: 'object',
  properties: {
    items: { type: 'array', items: item, description: 'Записи текущей страницы' },
    state: { type: 'string', enum: ['active', 'archived', 'deleted', 'all'], description: 'Фактически применённое состояние' },
    counts: {
      type: 'object',
      description: 'Количество записей в каждом состоянии с учётом остальных фильтров (для переключателя)',
      properties: {
        active: { type: 'integer' },
        archived: { type: 'integer' },
        deleted: { type: 'integer', description: 'Только для администраторов' },
        all: { type: 'integer', description: 'Для не-администраторов — без корзины' }
      }
    },
    total: { type: 'integer', description: 'Всего записей по фильтрам' },
    page: { type: 'integer', description: 'Фактическая страница' },
    pageSize: { type: 'integer', description: 'Фактический размер страницы' },
    sort: {
      type: 'object',
      description: 'Фактически применённая сортировка',
      properties: {
        key: { type: 'string', enum: sortKeys },
        dir: { type: 'string', enum: ['asc', 'desc'] }
      }
    }
  }
});

const TEXT_FILTER = 'подстрока без учёта регистра';

const VACANCY_SORTS = ['number', 'name', 'status', 'templates', 'candidates', 'createdAt', 'updatedAt', 'deletedAt'];
const SOURCE_SORTS = ['number', 'name', 'createdAt', 'deletedAt'];
const TEMPLATE_SORTS = ['number', 'name', 'questions', 'usage', 'createdAt', 'updatedAt', 'deletedAt'];
const VACANCY_PRESET_SORTS = ['number', 'name', 'stages', 'vacancies', 'createdAt', 'updatedAt', 'deletedAt'];
const USER_SORTS = [
  'email', 'name', 'lastName', 'firstName', 'middleName', 'stages', 'deletedAt',
  'status', 'admin', 'lastLogin', 'requested', 'createdAt'
];

// ---------- Интеграции ----------

const INTEGRATION_ARGS_GROUP = {
  type: 'string',
  enum: INTEGRATION_GROUPS,
  description: 'Группа настроек: auth — вход через Google, smtp — эл. почта, telegram — Telegram-бот'
};

const INTEGRATION_VALUES = {
  type: 'object',
  description:
    'Значения полей группы по ключу настройки. Ключи других групп и неизвестные ключи игнорируются; ' +
    'отсутствующий ключ — «не менять». Списки (allowedDomains/allowedEmails) — строка через запятую, пробел или «;». ' +
    'Секреты (auth.googleClientSecret, smtp.pass, telegram.botToken): пустая строка — оставить текущее значение.',
  properties: {
    'auth.googleClientId': { type: 'string', description: 'OAuth Client ID; должен оканчиваться на .apps.googleusercontent.com' },
    'auth.googleClientSecret': { type: 'string', description: 'Секрет. OAuth Client secret' },
    'auth.allowedDomains': { type: 'string', description: 'Домены с автоматическим доступом, через запятую' },
    'auth.allowedEmails': { type: 'string', description: 'Email с автоматическим доступом, через запятую' },
    'smtp.host': { type: 'string', description: 'SMTP-сервер (имя хоста)' },
    'smtp.port': { type: ['integer', 'string'], minimum: 1, maximum: 65535, description: 'Порт 1–65535' },
    'smtp.secure': { type: ['boolean', 'string'], description: 'TLS сразу (true / "true"); иначе STARTTLS' },
    'smtp.user': { type: 'string', description: 'Логин SMTP' },
    'smtp.pass': { type: 'string', description: 'Секрет. Пароль SMTP' },
    'smtp.from': { type: 'string', description: 'Отправитель, например «Recruiting ATS <noreply@company.kz>»; пусто — логин' },
    'telegram.botToken': { type: 'string', description: 'Секрет. Токен бота вида 123456789:AA…' },
    'telegram.polling': { type: ['boolean', 'string'], description: 'Принимать сообщения бота (long polling)' }
  },
  additionalProperties: true
};

const INTEGRATION_FIELD = {
  type: 'object',
  description: 'Поле настройки. У секретов вместо value — isSet и hintValue',
  properties: {
    key: { type: 'string', enum: INTEGRATION_KEYS, description: 'Ключ настройки' },
    label: { type: 'string', description: 'Подпись поля' },
    type: { type: 'string', enum: ['text', 'secret', 'number', 'bool', 'list'], description: 'Тип поля' },
    env: { type: 'string', description: 'Имя переменной окружения, из которой берётся значение по умолчанию' },
    hint: { type: 'string', description: 'Подсказка' },
    placeholder: { type: 'string', description: 'Пример значения' },
    source: { type: 'string', enum: ['db', 'env', 'default', 'none'], description: 'Откуда действующее значение: из настроек ATS (БД), из .env, значение по умолчанию, не задано' },
    broken: { type: 'boolean', description: 'Сохранённый секрет не удалось расшифровать (сменился ключ) — действует значение из .env' },
    value: {
      type: ['string', 'number', 'boolean'],
      description: 'Действующее значение (не для секретов); списки — строкой через «, »'
    },
    isSet: { type: 'boolean', description: 'Только для секретов: значение задано' },
    hintValue: { type: 'string', description: 'Только для секретов: маска «••••» + последние 4 символа; пустая строка — не задан' }
  }
};

const INTEGRATION_SETTINGS = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      description: 'Группы настроек в порядке auth, smtp, telegram',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: INTEGRATION_GROUPS, description: 'Ключ группы' },
          title: { type: 'string', description: 'Название группы' },
          description: { type: 'string', description: 'Описание группы' },
          fields: { type: 'array', items: INTEGRATION_FIELD, description: 'Поля группы' },
          overridden: { type: 'boolean', description: 'Хотя бы одно поле переопределено в настройках ATS (БД)' },
          updatedAt: { type: 'string', description: 'Время последнего изменения в ISO 8601; пустая строка — не менялось' },
          updatedBy: { type: 'string', description: 'Кто последним изменял (ФИО или email)' }
        }
      }
    },
    info: {
      type: 'object',
      description: 'Справочная информация для настройки',
      properties: {
        authMode: { type: 'string', enum: ['google', 'dev'], description: 'Режим входа (AUTH_MODE)' },
        redirectUri: { type: 'string', description: 'Redirect URI для OAuth-клиента Google' },
        javascriptOrigin: { type: 'string', description: 'Authorized JavaScript origin' },
        adminEmails: { type: 'array', items: { type: 'string' }, description: 'Администраторы из AUTH_ADMIN_EMAILS (в интерфейсе не меняются)' },
        encryptionKey: { type: 'string', enum: ['SETTINGS_ENCRYPTION_KEY', 'SESSION_SECRET', 'dev'], description: 'Откуда выведен ключ шифрования секретов' }
      }
    }
  }
};

const ADMIN_ONLY = 'Только для администраторов (иначе 403).';

export default {
  // ---------- Пользователи ----------

  getAdminUserData: {
    tag: 'Пользователи',
    summary: 'Список пользователей с открытым доступом',
    description:
      'Возвращает всех пользователей с открытым доступом, не в архиве и не в корзине, отсортированных по ФИО (или email). ' +
      'Список содержит email и роли, поэтому доступен **только администраторам** (иначе 403). `args` игнорируется.',
    args: null,
    result: {
      type: 'object',
      properties: {
        users: { type: 'array', items: USER, description: 'Пользователи с доступом' }
      }
    }
  },

  listUsers: {
    tag: 'Пользователи',
    summary: 'Таблица пользователей: фильтры, сортировка, пагинация',
    description:
      `${ADMIN_ONLY}\n\n` +
      'Серверная таблица пользователей (фильтрация, сортировка и пагинация в PostgreSQL). ' +
      'Сортировка по умолчанию — `status` по возрастанию (сначала ожидающие доступа, затем активные, затем отключённые); ' +
      'при равенстве — по email.\n\n' +
      'Фильтры `text` — подстрока без учёта регистра; `stage`, `responsible`, `status`, `admin` — точное значение из перечня ' +
      '(недопустимое значение игнорируется).',
    args: listArgs({
      sortKeys: USER_SORTS,
      defaultSort: 'status asc',
      filters: {
        email: { type: 'string', description: `Email: ${TEXT_FILTER}` },
        name: { type: 'string', description: `Фамилия, имя, отчество или полное имя: ${TEXT_FILTER}` },
        lastName: { type: 'string', description: `Фамилия: ${TEXT_FILTER}` },
        firstName: { type: 'string', description: `Имя: ${TEXT_FILTER}` },
        middleName: { type: 'string', description: `Отчество: ${TEXT_FILTER}` },
        stage: { type: 'string', enum: PIPELINE_STAGES, description: 'Пользователь отвечает за этот этап' },
        responsible: { type: 'string', enum: ['yes', 'no'], description: 'Есть ли у пользователя этапы (ответственный)' },
        status: { type: 'string', enum: ['active', 'pending', 'disabled'], description: 'Статус доступа' },
        admin: { type: 'string', enum: ['yes', 'no'], description: 'Права администратора' }
      }
    }),
    example: {
      page: 1,
      pageSize: 20,
      sort: { key: 'lastLogin', dir: 'desc' },
      filters: { state: 'active', status: 'active', stage: 'HR screening' }
    },
    result: listResult(USER, USER_SORTS)
  },

  saveUser: {
    tag: 'Пользователи',
    summary: 'Создать или изменить пользователя',
    description:
      `${ADMIN_ONLY}\n\n` +
      'Без `id` — создаёт пользователя (нужен `email`); с `id` — обновляет ФИО, этапы, права администратора и Telegram. ' +
      'Доступ в ATS для существующего пользователя переключается отдельно (`setUserAccess`), но назначение администратором открывает доступ.\n\n' +
      'Правила:\n' +
      '- `lastName` и `firstName` обязательны.\n' +
      '- `stages` — только этапы воронки (иначе ошибка), порядок нормализуется по воронке.\n' +
      '- Новый пользователь получает доступ сразу, если `isActive: true` или `isAdmin: true`.\n' +
      '- Email нового пользователя уникален (409). У существующего email меняется, только пока он ни разу не входил через Google.\n' +
      '- Нельзя снять права администратора с себя и с последнего администратора.\n' +
      '- `telegram` — ник 5–32 символа `[A-Za-z0-9_]` (допустимы «@», t.me/…); смена ника сбрасывает подтверждение привязки. Не передан — не меняется.\n\n' +
      'Пишет в журнал изменений: создание или изменённые поля (и событие «Доступ в ATS», если доступ открылся).',
    args: {
      type: 'object',
      required: ['lastName', 'firstName'],
      properties: {
        id: uuid('ID пользователя; пусто — создать нового'),
        email: { type: 'string', format: 'email', description: 'Email Google Account (обязателен при создании)' },
        lastName: { type: 'string', description: 'Фамилия' },
        firstName: { type: 'string', description: 'Имя' },
        middleName: { type: 'string', description: 'Отчество' },
        stages: { type: 'array', items: { type: 'string', enum: PIPELINE_STAGES }, description: 'Этапы, за которые отвечает пользователь' },
        isAdmin: { type: 'boolean', default: false, description: 'Права администратора (только значение true включает)' },
        isActive: { type: 'boolean', default: false, description: 'Только при создании: сразу открыть доступ' },
        telegram: { type: 'string', description: 'Ник Telegram; пустая строка — очистить, отсутствует — не менять' }
      }
    },
    example: {
      email: 'recruiter@example.com',
      lastName: 'Иванова',
      firstName: 'Анна',
      middleName: '',
      stages: ['Новый', 'HR screening'],
      isAdmin: false,
      isActive: true,
      telegram: '@anna_hr'
    },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        user: USER
      }
    }
  },

  setUserAccess: {
    tag: 'Пользователи',
    summary: 'Открыть или закрыть пользователю доступ в ATS',
    description:
      `${ADMIN_ONLY}\n\n` +
      'Переключатель «Доступ в ATS». Закрытие доступа снимает и права администратора.\n\n' +
      'Ошибки: пользователь не найден (404); пользователь в архиве или корзине; нельзя закрыть доступ самому себе; ' +
      'нельзя закрыть доступ последнему администратору.\n\n' +
      'При изменении пишет событие «Доступ в ATS» в журнал изменений.',
    args: {
      type: 'object',
      required: ['id'],
      properties: {
        id: uuid('ID пользователя'),
        isActive: { type: 'boolean', default: false, description: 'true — открыть доступ, иначе закрыть' }
      }
    },
    example: { id: '00000000-0000-4000-8000-000000000001', isActive: true },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        user: USER
      }
    }
  },

  // ---------- Интеграции ----------

  getIntegrationSettings: {
    tag: 'Интеграции (админ)',
    summary: 'Настройки интеграций: Google-вход, SMTP, Telegram',
    description:
      `${ADMIN_ONLY}\n\n` +
      'Возвращает группы настроек с действующими значениями и их источником (БД, .env, по умолчанию). ' +
      'Значение из настроек ATS важнее переменной окружения. Секреты наружу не отдаются — только признак `isSet` и маска `hintValue`. ' +
      '`args` игнорируется.',
    args: null,
    result: INTEGRATION_SETTINGS
  },

  saveIntegration: {
    tag: 'Интеграции (админ)',
    summary: 'Сохранить настройки группы интеграций',
    description:
      `${ADMIN_ONLY}\n\n` +
      'Сохраняет переданные поля группы в таблицу `app_settings` (переопределяют .env) и применяет их без перезапуска. ' +
      'Возвращает обновлённые настройки, как `getIntegrationSettings`.\n\n' +
      '**Секреты** (`auth.googleClientSecret`, `smtp.pass`, `telegram.botToken`) хранятся зашифрованными (AES-256-GCM, ключ из ' +
      '`SETTINGS_ENCRYPTION_KEY` или `SESSION_SECRET`) и в ответе маскируются (`••••` + последние 4 символа). ' +
      'Пустое значение секрета — оставить текущее; очистить секрет можно только сбросом группы (`resetIntegration`).\n\n' +
      'Проверки (по объединению введённых и текущих значений):\n' +
      '- auth: в режиме `google` нужны Client ID и Client secret; Client ID оканчивается на `.apps.googleusercontent.com`; ' +
      'домены и email списков проверяются. При изменении Client ID/secret пара сначала проверяется запросом к Google — неверный клиент не сохраняется.\n' +
      '- smtp: при заданном хосте — корректное имя хоста, отправитель или логин с корректным email.\n' +
      '- smtp.port — целое 1–65535.\n' +
      '- telegram: токен вида `123456789:AA…`.\n\n' +
      'В журнал изменений не пишет; в `app_settings` сохраняется, кто и когда изменил.',
    args: {
      type: 'object',
      required: ['group'],
      properties: {
        group: INTEGRATION_ARGS_GROUP,
        values: INTEGRATION_VALUES
      }
    },
    example: {
      group: 'smtp',
      values: {
        'smtp.host': 'smtp.example.com',
        'smtp.port': 465,
        'smtp.secure': true,
        'smtp.user': 'noreply@example.com',
        'smtp.pass': '',
        'smtp.from': 'Recruiting ATS <noreply@example.com>'
      }
    },
    result: INTEGRATION_SETTINGS
  },

  testIntegration: {
    tag: 'Интеграции (админ)',
    summary: 'Проверить подключение интеграции без сохранения',
    description:
      `${ADMIN_ONLY}\n\n` +
      'Проверяет группу с учётом введённых, но не сохранённых значений (`values`, те же правила, что в `saveIntegration`); ничего не сохраняет.\n\n' +
      '- auth: обмен заведомо неверного кода в Google — проверяет, что Client ID/secret настоящие и Redirect URI указан.\n' +
      '- smtp: подключается к серверу и отправляет тестовое письмо на email текущего пользователя.\n' +
      '- telegram: вызывает `getMe` Bot API.\n\n' +
      'При неудаче — ошибка 400 с причиной.',
    args: {
      type: 'object',
      required: ['group'],
      properties: {
        group: INTEGRATION_ARGS_GROUP,
        values: INTEGRATION_VALUES
      }
    },
    example: { group: 'telegram', values: { 'telegram.botToken': '' } },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        message: { type: 'string', description: 'Сообщение об успешной проверке' },
        botUsername: { type: 'string', description: 'Только для telegram: username бота' }
      }
    }
  },

  resetIntegration: {
    tag: 'Интеграции (админ)',
    summary: 'Сбросить группу интеграций к значениям из .env',
    description:
      `${ADMIN_ONLY}\n\n` +
      '«Сбросить к .env»: удаляет все переопределения группы из `app_settings` (включая секреты) и применяет значения из окружения. ' +
      'Для `auth` в режиме `google` запрещено, если в .env не заданы `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. ' +
      'В журнал изменений не пишет. Возвращает обновлённые настройки, как `getIntegrationSettings`.',
    args: {
      type: 'object',
      required: ['group'],
      properties: { group: INTEGRATION_ARGS_GROUP }
    },
    example: { group: 'telegram' },
    result: INTEGRATION_SETTINGS
  },

  // ---------- Вакансии ----------

  listVacancies: {
    tag: 'Вакансии',
    summary: 'Таблица вакансий: фильтры, сортировка, пагинация',
    description:
      'Серверная таблица вакансий. Доступно любому авторизованному пользователю; корзину (`state: deleted`) видят только администраторы.\n\n' +
      'Сортировка по умолчанию — `number` по убыванию; при равенстве — по ID. `status` сортируется в порядке «Открыта», «На паузе», «Закрыта»; ' +
      '`templates` — по числу активных привязанных шаблонов, `candidates` — по числу кандидатов (не в корзине).',
    args: listArgs({
      sortKeys: VACANCY_SORTS,
      defaultSort: 'number desc',
      filters: {
        number: { type: ['integer', 'string'], description: 'Номер вакансии (точное целое; нецелое игнорируется)' },
        name: { type: 'string', description: `Название: ${TEXT_FILTER}` },
        status: { type: 'string', enum: VACANCY_STATUSES, description: 'Статус вакансии' }
      }
    }),
    example: {
      page: 1,
      pageSize: 20,
      sort: { key: 'name', dir: 'asc' },
      filters: { state: 'active', status: 'Открыта', name: 'backend' }
    },
    result: listResult(
      {
        type: 'object',
        description: 'Вакансия с привязками шаблонов и числом кандидатов',
        properties: {
          ...VACANCY.properties,
          templates: {
            type: 'array',
            description: 'Шаблоны на этапах вакансии (в порядке воронки), без шаблонов в корзине',
            items: STAGE_TEMPLATE
          },
          candidateCount: { type: 'integer', description: 'Кандидатов на вакансии (не в корзине)' }
        }
      },
      VACANCY_SORTS
    )
  },

  saveVacancy: {
    tag: 'Вакансии',
    summary: 'Создать или изменить вакансию и её этапы',
    description:
      'Доступно любому авторизованному пользователю. Без `id` — создаёт вакансию со статусом «Открыта»; с `id` — обновляет. ' +
      'Статус здесь не меняется — для этого `setVacancyStatus`.\n\n' +
      'Правила:\n' +
      '- `name` обязателен и уникален среди вакансий не в корзине, без учёта регистра (409).\n' +
      '- `links` — до 20 ссылок, каждая http(s); дубли по URL отбрасываются; не передан — не меняется.\n' +
      '- `templates` — полный список этапов вакансии (заменяет прежний); не передан — не меняется. ' +
      'На этапе не больше одного шаблона; этап — из воронки; новые привязки — только к активным шаблонам ' +
      '(уже привязанный архивный шаблон остаётся). Необязательный этап без шаблона не сохраняется.\n' +
      '- `presetId` — шаблон вакансии. Если `templates` не передан, этапы копируются из шаблона один раз (шаблон должен быть ' +
      'активным: в архиве — 400, не найден или в корзине — 404) — дальше вакансия и шаблон меняются независимо; этап, на котором ' +
      'шаблон интервью в архиве или корзине, копируется без шаблона (обязательность сохраняется) и попадает в `skippedStages`. ' +
      'С переданным `templates` `presetId` — только ссылка: проверок нет. У новой вакансии запоминается, из какого шаблона ' +
      'она создана (`presetId` в ответе; несуществующий шаблон не запоминается).\n\n' +
      'Пишет в журнал изменений: создание, шаблон вакансии (при создании из шаблона), изменённые поля и изменение этапов.',
    args: {
      type: 'object',
      required: ['name'],
      properties: {
        id: uuid('ID вакансии; пусто — создать новую'),
        name: { type: 'string', description: 'Название вакансии' },
        links: {
          type: 'array',
          maxItems: 20,
          items: VACANCY_LINK,
          description: 'Ссылки на публикации (hh, Telegram, LinkedIn и т. п.)'
        },
        templates: {
          type: 'array',
          description: 'Этапы вакансии: шаблон интервью и/или обязательность',
          items: STAGE_INPUT
        },
        presetId: uuid('ID шаблона вакансии: этапы из него, если templates не передан')
      }
    },
    example: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Senior .NET Developer',
      links: [{ url: 'https://hh.kz/vacancy/123456', name: 'hh.kz' }],
      templates: [
        { stage: 'HR screening', templateId: '00000000-0000-4000-8000-000000000002', required: true },
        { stage: 'Проф. интервью', templateId: '00000000-0000-4000-8000-000000000003', required: true },
        { stage: 'Финальное интервью', required: true }
      ]
    },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        vacancy: VACANCY,
        skippedStages: { ...SKIPPED_STAGES, description: `Только когда этапы скопированы из presetId. ${SKIPPED_STAGES.description}` }
      }
    }
  },

  setVacancyStatus: {
    tag: 'Вакансии',
    summary: 'Сменить статус вакансии',
    description:
      'Доступно любому авторизованному пользователю. Разрешённые переходы: «Открыта» → «На паузе» / «Закрыта»; ' +
      '«На паузе» → «Открыта» / «Закрыта»; «Закрыта» → «Открыта». Иначе — ошибка 400.\n\n' +
      'Ошибки: вакансия не найдена (404); вакансия в архиве или корзине.\n\n' +
      'Пишет событие смены статуса в журнал изменений.',
    args: {
      type: 'object',
      required: ['id', 'status'],
      properties: {
        id: uuid('ID вакансии'),
        status: { type: 'string', enum: VACANCY_STATUSES, description: 'Новый статус' }
      }
    },
    example: { id: '00000000-0000-4000-8000-000000000001', status: 'На паузе' },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        vacancy: VACANCY
      }
    }
  },

  // ---------- Источники ----------

  listSources: {
    tag: 'Источники',
    summary: 'Таблица источников: фильтры, сортировка, пагинация',
    description:
      'Серверная таблица источников кандидатов. Доступно любому авторизованному пользователю; корзину (`state: deleted`) видят только администраторы.\n\n' +
      'Сортировка по умолчанию — `name` по возрастанию; при равенстве — по ID.',
    args: listArgs({
      sortKeys: SOURCE_SORTS,
      defaultSort: 'name asc',
      filters: {
        number: { type: ['integer', 'string'], description: 'Номер источника (точное целое; нецелое игнорируется)' },
        name: { type: 'string', description: `Название: ${TEXT_FILTER}` }
      }
    }),
    example: { page: 1, pageSize: 50, sort: { key: 'name', dir: 'asc' }, filters: { state: 'all', name: 'hh' } },
    result: listResult(SOURCE, SOURCE_SORTS)
  },

  saveSource: {
    tag: 'Источники',
    summary: 'Создать или изменить источник кандидатов',
    description:
      'Доступно любому авторизованному пользователю. Без `id` — создаёт источник, с `id` — обновляет.\n\n' +
      'Правила:\n' +
      '- `name` обязателен и уникален среди источников не в корзине (409).\n' +
      '- `iconKey` — ключ пресета из списка или пустая строка (определить по названию); не передан — не меняется.\n' +
      '- `iconData` — своя иконка: data URL `data:image/png;base64,…`, только PNG, до 64 КБ; пустая строка — убрать свою картинку; не передан — не меняется. ' +
      'Своя картинка важнее пресета.\n\n' +
      'Пишет в журнал изменений: создание или изменённые поля.',
    args: {
      type: 'object',
      required: ['name'],
      properties: {
        id: uuid('ID источника; пусто — создать новый'),
        name: { type: 'string', description: 'Название источника' },
        iconKey: { type: 'string', enum: ['', ...SOURCE_ICON_KEYS], description: 'Ключ пресета иконки; пустая строка — определить по названию' },
        iconData: { type: 'string', description: 'PNG data URL (до 64 КБ, редактор отдаёт 64×64); пустая строка — удалить свою картинку' }
      }
    },
    example: { name: 'hh.kz', iconKey: 'hh' },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        source: SOURCE
      }
    }
  },

  // ---------- Шаблоны интервью ----------

  listTemplates: {
    tag: 'Шаблоны интервью',
    summary: 'Таблица шаблонов интервью: фильтры, сортировка, пагинация',
    description:
      'Серверная таблица шаблонов интервью. Доступно любому авторизованному пользователю; корзину (`state: deleted`) видят только администраторы.\n\n' +
      'Сортировка по умолчанию — `number` по убыванию; при равенстве — по ID. `questions` — по числу вопросов, ' +
      '`usage` — по числу вакансий (не в корзине), использующих шаблон. Шаблоны вакансий, где используется шаблон, — в `presets`.',
    args: listArgs({
      sortKeys: TEMPLATE_SORTS,
      defaultSort: 'number desc',
      filters: {
        number: { type: ['integer', 'string'], description: 'Номер шаблона (точное целое; нецелое игнорируется)' },
        name: { type: 'string', description: `Название: ${TEXT_FILTER}` },
        tag: { type: 'string', description: `Названия тегов: ${TEXT_FILTER}` }
      }
    }),
    example: { page: 1, pageSize: 20, sort: { key: 'usage', dir: 'desc' }, filters: { tag: '.NET' } },
    result: listResult(
      {
        type: 'object',
        description: 'Шаблон интервью с вакансиями, которые его используют',
        properties: {
          ...TEMPLATE_PROPS,
          vacancies: {
            type: 'array',
            description: 'Привязки к вакансиям (не в корзине): вакансия + этап',
            items: {
              type: 'object',
              properties: {
                id: uuid('ID вакансии'),
                number: { type: 'integer', description: 'Номер вакансии' },
                name: { type: 'string', description: 'Название вакансии' },
                stage: { type: 'string', enum: PIPELINE_STAGES, description: 'Этап' },
                required: { type: 'boolean', description: 'Обязательный этап' }
              }
            }
          },
          presets: {
            type: 'array',
            description: 'Шаблоны вакансий (не в корзине), где используется шаблон: шаблон вакансии + этап',
            items: {
              type: 'object',
              properties: {
                id: uuid('ID шаблона вакансии'),
                number: { type: 'integer', description: 'Номер шаблона вакансии' },
                name: { type: 'string', description: 'Название шаблона вакансии' },
                stage: { type: 'string', enum: PIPELINE_STAGES, description: 'Этап' },
                required: { type: 'boolean', description: 'Обязательный этап' }
              }
            }
          }
        }
      },
      TEMPLATE_SORTS
    )
  },

  saveInterviewTemplate: {
    tag: 'Шаблоны интервью',
    summary: 'Создать или изменить шаблон интервью',
    description:
      'Доступно любому авторизованному пользователю. Без `id` — создаёт шаблон, с `id` — обновляет название, вопросы и теги ' +
      '(все три поля перезаписываются). Привязка к вакансиям и этапам — в `saveVacancy`.\n\n' +
      'Правила:\n' +
      '- `name` обязателен.\n' +
      '- Нужен хотя бы один вопрос с непустым `text`; вопрос может быть строкой (старый формат) или объектом; ' +
      'пустые вопросы отбрасываются, ответы очищаются от пустых и дублей.\n' +
      '- `tags` — до 10 тегов, название до 40 символов, дубли (без учёта регистра) отбрасываются; неизвестный цвет заменяется на `gray`.\n\n' +
      'Пишет в журнал изменений: создание или изменённые поля.',
    args: {
      type: 'object',
      required: ['name', 'questions'],
      properties: {
        id: uuid('ID шаблона; пусто — создать новый'),
        name: { type: 'string', description: 'Название шаблона' },
        questions: {
          type: 'array',
          minItems: 1,
          description: 'Вопросы шаблона',
          items: {
            type: ['object', 'string'],
            description: 'Вопрос: объект { text, answers } или строка с текстом',
            properties: TEMPLATE_QUESTION.properties
          }
        },
        tags: {
          type: 'array',
          maxItems: 10,
          items: TEMPLATE_TAG,
          description: 'Теги шаблона'
        }
      }
    },
    example: {
      name: 'HR screening — backend',
      questions: [
        { text: 'Почему рассматриваете смену работы?', answers: ['Рост', 'Новые задачи'] },
        { text: 'Зарплатные ожидания?', answers: [] }
      ],
      tags: [{ name: 'backend', color: 'blue' }]
    },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        template: {
          type: 'object',
          description: 'Сохранённый шаблон',
          properties: TEMPLATE_PROPS
        }
      }
    }
  },

  // ---------- Шаблоны вакансий ----------

  listVacancyPresets: {
    tag: 'Шаблоны вакансий',
    summary: 'Таблица шаблонов вакансий: фильтры, сортировка, пагинация',
    description:
      'Серверная таблица шаблонов вакансий. Доступно любому авторизованному пользователю; корзину (`state: deleted`) видят только администраторы.\n\n' +
      'Сортировка по умолчанию — `number` по убыванию; при равенстве — по ID. `stages` — по числу настроенных этапов ' +
      '(с шаблоном интервью или обязательных), `vacancies` — по числу вакансий, созданных из шаблона.',
    args: listArgs({
      sortKeys: VACANCY_PRESET_SORTS,
      defaultSort: 'number desc',
      filters: {
        number: { type: ['integer', 'string'], description: 'Номер шаблона вакансии (точное целое; нецелое игнорируется)' },
        name: { type: 'string', description: `Название: ${TEXT_FILTER}` }
      }
    }),
    example: { page: 1, pageSize: 20, sort: { key: 'name', dir: 'asc' }, filters: { state: 'active', name: '.NET' } },
    result: listResult(VACANCY_PRESET, VACANCY_PRESET_SORTS)
  },

  saveVacancyPreset: {
    tag: 'Шаблоны вакансий',
    summary: 'Создать или изменить шаблон вакансии и его этапы',
    description:
      'Доступно любому авторизованному пользователю. Без `id` — создаёт шаблон вакансии, с `id` — обновляет. ' +
      'Шаблон вакансии — готовый набор этапов: новую вакансию создают из него через `saveVacancy` с `presetId`.\n\n' +
      'Правила:\n' +
      '- `name` обязателен и уникален среди шаблонов вакансий не в корзине, без учёта регистра (409).\n' +
      '- `templates` — полный список этапов (заменяет прежний); не передан — не меняется. Правила те же, что у ' +
      '`saveVacancy`: на этапе не больше одного шаблона интервью, новые привязки — только к активным шаблонам, ' +
      'необязательный этап без шаблона не сохраняется.\n' +
      '- `fromVacancyId` — взять этапы из вакансии (если `templates` не передан); этап, на котором шаблон интервью ' +
      'в архиве или корзине, копируется без шаблона и попадает в `skippedStages`.\n' +
      '- Шаблон вакансии в корзине изменить нельзя — сначала восстановите его.\n\n' +
      'Пишет в журнал изменений: создание, изменённое название и изменение этапов.',
    args: {
      type: 'object',
      required: ['name'],
      properties: {
        id: uuid('ID шаблона вакансии; пусто — создать новый'),
        name: { type: 'string', description: 'Название шаблона вакансии' },
        templates: {
          type: 'array',
          description: 'Этапы: шаблон интервью и/или обязательность',
          items: STAGE_INPUT
        },
        fromVacancyId: uuid('ID вакансии: взять этапы из неё, если templates не передан')
      }
    },
    example: {
      name: '.NET разработчик',
      templates: [
        { stage: 'HR screening', templateId: '00000000-0000-4000-8000-000000000002', required: true },
        { stage: 'Проф. интервью', templateId: '00000000-0000-4000-8000-000000000003', required: true },
        { stage: 'Финальное интервью', required: true }
      ]
    },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        preset: VACANCY_PRESET,
        skippedStages: { ...SKIPPED_STAGES, description: `Только при fromVacancyId. ${SKIPPED_STAGES.description}` }
      }
    }
  }
};
