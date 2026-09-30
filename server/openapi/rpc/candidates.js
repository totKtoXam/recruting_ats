// OpenAPI-описание RPC-методов: старт приложения, справочники и кандидаты.

const PIPELINE_STATUSES = ['Новый', 'HR screening', 'Проф. интервью', 'Финальное интервью', 'Offer', 'Hired'];
const CANDIDATE_STATUSES = [...PIPELINE_STATUSES, 'Отказано'];
const DATE_TIME_DESC = 'Дата и время «yyyy-MM-dd HH:mm:ss» в часовом поясе приложения; пустая строка — нет значения.';

const uuidArg = description => ({ type: 'string', format: 'uuid', description });
const dateTime = description => ({ type: 'string', description: description + ' ' + DATE_TIME_DESC });

// Поля состояния записи (lifecycleFields).
const lifecycleProps = {
  state: { type: 'string', enum: ['active', 'archived', 'deleted'], description: 'Состояние записи: активна, в архиве, в корзине.' },
  archivedAt: dateTime('Дата архивации.'),
  deletedAt: dateTime('Дата перемещения в корзину.'),
  purgeAt: dateTime('Дата окончательного удаления из корзины.'),
  daysUntilPurge: { type: ['integer', 'null'], description: 'Сколько дней осталось до окончательного удаления; null — не в корзине.' }
};

const linkItem = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Название ссылки.' },
    url: { type: 'string', description: 'URL (http/https).' }
  }
};

const resumeVersion = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'ID файла.' },
    url: { type: 'string', description: 'Ссылка на файл (Google Drive или /files/<id> приложения).' },
    name: { type: 'string', description: 'Исходное имя файла.' },
    uploadedAt: dateTime('Дата загрузки.')
  }
};

// Кандидат в формате списка (toCandidate без версий резюме).
const candidateProps = {
  'ID': { type: 'string', format: 'uuid', description: 'ID кандидата.' },
  '№': { type: 'integer', description: 'Порядковый номер кандидата.' },
  'Фамилия': { type: 'string' },
  'Имя': { type: 'string' },
  'Отчество': { type: 'string', description: 'Пустая строка, если нет.' },
  'ФИО': { type: 'string', description: 'Фамилия Имя Отчество.' },
  'Vacancy ID': { type: 'string', format: 'uuid' },
  'Vacancy №': { type: 'integer', description: 'Номер вакансии.' },
  'Вакансия': { type: 'string', description: 'Название вакансии.' },
  'Статус': { type: 'string', enum: CANDIDATE_STATUSES, description: 'Этап воронки.' },
  'Телефон': { type: 'string', description: 'Формат «+7 7XX XXX XX XX».' },
  'Email': { type: 'string' },
  'Telegram': { type: 'string', description: '«@username» или ссылка.' },
  'Telegram URL': { type: 'string' },
  'LinkedIn': { type: 'string' },
  'GitHub': { type: 'string' },
  'Source ID': { type: 'string', description: 'ID источника или пустая строка.' },
  'Источник': { type: 'string', description: 'Название источника или пустая строка.' },
  'Зарплатные ожидания': { type: ['integer', 'string'], description: 'Сумма в тенге; пустая строка — не указано.' },
  'Responsible ID': { type: 'string', format: 'uuid', description: 'ID рекрутера.' },
  'Ответственный': { type: 'string', description: 'ФИО рекрутера.' },
  'HR Responsible ID': { type: 'string', format: 'uuid' },
  'Ответственный HR': { type: 'string' },
  'Tech Interviewer ID': { type: 'string', format: 'uuid' },
  'Ответственный проф. интервьювер': { type: 'string' },
  'Резюме': { type: 'string', description: 'Ссылка на последнюю версию резюме или пустая строка.' },
  'Resume File ID': { type: 'string', description: 'ID файла последнего резюме или пустая строка.' },
  'Папка кандидата': { type: 'string', description: 'Путь «/candidates/<id>/files» (с BASE_PATH).' },
  'Дата добавления': dateTime('Дата создания.'),
  'Дата изменения': dateTime('Дата последнего изменения.'),
  'Архивирован': { type: 'boolean' },
  'Дата архивации': dateTime('Дата архивации.'),
  ...lifecycleProps,
  'Причина отказа': { type: 'string', description: 'Причина отказа или пустая строка.' },
  'Комментарий к отказу': { type: 'string', description: 'HTML-комментарий к отказу.' },
  'Кем отказано': { type: 'string', description: '«Кандидат», ФИО ответственного или пустая строка.' },
  'Дата отказа': dateTime('Дата отказа.'),
  rejection: {
    type: ['object', 'null'],
    description: 'Данные отказа; null, если кандидату не отказывали.',
    properties: {
      fromStatus: { type: 'string', description: 'Этап, с которого отказали (на него можно вернуть).' },
      byType: { type: 'string', enum: ['candidate', 'responsible', ''], description: 'Кто отказал: кандидат или компания.' },
      byResponsibleId: { type: 'string', description: 'ID отказавшего ответственного или пустая строка.' },
      reason: { type: 'string' },
      comment: { type: 'string' }
    }
  },
  archived: { type: 'boolean', description: 'Дублирует «Архивирован».' }
};

const candidateSummary = {
  type: 'object',
  description: 'Кандидат (строка списка).',
  properties: candidateProps
};

// Полная карточка: плюс ссылки и версии резюме.
const candidateDetails = {
  type: 'object',
  description: 'Полная карточка кандидата.',
  properties: {
    ...candidateProps,
    links: { type: 'array', items: linkItem, description: 'Иные ссылки.' },
    resumeVersions: { type: 'array', items: resumeVersion, description: 'Версии резюме, новые первыми.' },
    'Иные ссылки': { type: 'string', description: 'links в виде JSON-строки.' },
    'Версии резюме': { type: 'string', description: 'resumeVersions в виде JSON-строки.' }
  }
};

const okCandidate = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', enum: [true] },
    candidate: candidateDetails
  }
};

const candidateStats = {
  type: 'object',
  properties: {
    total: { type: 'integer', description: 'Активных кандидатов.' },
    archived: { type: 'integer', description: 'Кандидатов в архиве.' },
    deleted: { type: 'integer', description: 'Кандидатов в корзине.' },
    byStatus: {
      type: 'object',
      description: 'Число активных кандидатов по статусу: { "<Статус>": число }.',
      additionalProperties: { type: 'integer' }
    }
  }
};

const candidateDataProps = {
  candidates: { type: 'array', items: candidateSummary, description: 'Активные кандидаты (не в архиве и не в корзине), по номеру.' },
  stats: candidateStats
};

const stringList = description => ({ type: 'array', items: { type: 'string' }, description });

const referenceDataProps = {
  vacancies: {
    type: 'array',
    description: 'Активные вакансии (не в архиве и не в корзине), по номеру.',
    items: {
      type: 'object',
      properties: {
        'Vacancy ID': { type: 'string', format: 'uuid' },
        '№': { type: 'integer' },
        'Вакансия': { type: 'string', description: 'Название.' },
        'Статус': { type: 'string', enum: ['Открыта', 'На паузе', 'Закрыта'] },
        links: { type: 'array', items: linkItem, description: 'Ссылки на публикации вакансии.' },
        requiredStages: stringList('Этапы, на которых при переходе обязателен итог.'),
        'Дата создания': dateTime('Дата создания.'),
        'Дата изменения': dateTime('Дата изменения.'),
        ...lifecycleProps
      }
    }
  },
  sources: {
    type: 'array',
    description: 'Активные источники кандидатов.',
    items: {
      type: 'object',
      properties: {
        'Source ID': { type: 'string', format: 'uuid' },
        '№': { type: 'integer' },
        'Название': { type: 'string' },
        iconKey: { type: 'string', description: 'Ключ иконки-пресета (см. sourceIconKeys) или пустая строка.' },
        iconUrl: { type: 'string', description: 'URL своей PNG-иконки или пустая строка.' },
        'Дата создания': dateTime('Дата создания.'),
        'Дата изменения': dateTime('Дата изменения.'),
        ...lifecycleProps
      }
    }
  },
  responsibles: {
    type: 'array',
    description: 'Ответственные — пользователи, у которых есть хотя бы один этап.',
    items: {
      type: 'object',
      properties: {
        'Responsible ID': { type: 'string', format: 'uuid' },
        'User ID': { type: 'string', format: 'uuid', description: 'Совпадает с Responsible ID.' },
        'Фамилия': { type: 'string' },
        'Имя': { type: 'string' },
        'Отчество': { type: 'string' },
        'ФИО': { type: 'string' },
        'Email': { type: 'string' },
        'Доступные этапы': { type: 'string', description: 'stages в виде JSON-строки.' },
        stages: { type: 'array', items: { type: 'string', enum: PIPELINE_STATUSES } },
        hasAccess: { type: 'boolean', description: 'Есть ли доступ в ATS.' }
      }
    }
  },
  interviewTemplates: {
    type: 'array',
    description: 'Привязки шаблонов к вакансиям и этапам: шаблон с полями «Vacancy ID», «Этап», «Обязательный»/required.',
    items: { type: 'object', additionalProperties: true }
  },
  templates: {
    type: 'array',
    description: 'Активные шаблоны интервью: «Template ID», «№», «Название», questions [{ text, answers[] }], tags [{ name, color }], usage (число вакансий) и поля состояния.',
    items: { type: 'object', additionalProperties: true }
  },
  templateTagColors: {
    type: 'array',
    items: { type: 'string', enum: ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'gray'] },
    description: 'Палитра цветов тегов шаблонов.'
  },
  dictionaries: {
    type: 'object',
    description: 'Справочники: { "<категория>": ["значение", ...] }.',
    additionalProperties: { type: 'array', items: { type: 'string' } }
  },
  transitions: {
    type: 'object',
    description: 'Разрешённые переходы: { "<этап>": ["<этап>", ...] }.',
    additionalProperties: { type: 'array', items: { type: 'string' } }
  },
  pipelineStatuses: { type: 'array', items: { type: 'string', enum: PIPELINE_STATUSES }, description: 'Этапы воронки по порядку.' },
  rejectedStatus: { type: 'string', enum: ['Отказано'] },
  profInterviewStatus: { type: 'string', enum: ['Проф. интервью'] },
  rejectionReasons: {
    type: 'object',
    description: 'Причины отказа из справочников «Причины отказа: кандидат» и «Причины отказа: компания».',
    properties: {
      candidate: stringList('Причины отказа со стороны кандидата.'),
      responsible: stringList('Причины отказа со стороны компании.')
    }
  },
  otherReason: { type: 'string', enum: ['Другое'], description: 'Причина, требующая комментария.' },
  vacancyStatusTransitions: {
    type: 'object',
    description: 'Переходы статусов вакансии: { "<статус>": ["<статус>", ...] }.',
    additionalProperties: { type: 'array', items: { type: 'string' } }
  },
  sourceIconKeys: stringList('Ключи иконок-пресетов источников.'),
  trashRetentionDays: { type: 'integer', description: 'Сколько дней запись хранится в корзине (30).' }
};

const referenceData = {
  type: 'object',
  properties: referenceDataProps
};

const bootstrapResult = {
  type: 'object',
  description: 'Всё, что нужно для первого рендера: пользователь, справочники и активные кандидаты.',
  properties: {
    currentUser: {
      type: 'object',
      description: 'Текущий пользователь (toPublicUser): «User ID», «Email», «ФИО», «Фамилия», «Имя», «Отчество», stages, telegram, telegramVerified, emailEditable, isAdmin, accessStatus, «Статус доступа», «Последний вход» и др.',
      additionalProperties: true,
      properties: {
        'User ID': { type: 'string', format: 'uuid' },
        'Email': { type: 'string' },
        'ФИО': { type: 'string' },
        stages: { type: 'array', items: { type: 'string', enum: PIPELINE_STATUSES } },
        isAdmin: { type: 'boolean' },
        accessStatus: { type: 'string', enum: ['active', 'pending', 'disabled'] }
      }
    },
    notificationsUnread: { type: 'integer', description: 'Непрочитанных уведомлений в приложении.' },
    ...referenceDataProps,
    ...candidateDataProps
  }
};

const bootstrap = {
  tag: 'Старт и справочники',
  summary: 'Стартовые данные приложения: пользователь, справочники, кандидаты',
  description:
    'Вызывается фронтендом при загрузке. Доступно любому авторизованному пользователю.\n\n' +
    'Побочные эффекты: обновляет «Последний вход» (не чаще раза в 30 минут); в фоне, не чаще раза в 12 часов, ' +
    'удаляет использованные/просроченные черновики кандидатов (их файлы — в корзину Google Drive) и окончательно ' +
    'удаляет записи, пролежавшие в корзине дольше 30 дней.\n\n' +
    'Ответ — объединение `getReferenceData` и `getCandidateData` плюс `currentUser` и `notificationsUnread`.',
  args: null,
  result: bootstrapResult
};

export default {
  getBootstrapData: bootstrap,

  getInitialData: {
    ...bootstrap,
    summary: 'Синоним getBootstrapData (устаревшее имя)',
    description: 'Алиас `getBootstrapData`: тот же обработчик, те же побочные эффекты и тот же ответ. Оставлен для совместимости.'
  },

  getReferenceData: {
    tag: 'Старт и справочники',
    summary: 'Справочники: вакансии, источники, ответственные, шаблоны, константы',
    description:
      'Возвращает активные (не в архиве и не в корзине) вакансии, источники, ответственных и шаблоны интервью, ' +
      'справочники, а также константы воронки. Только чтение, доступно любому авторизованному пользователю.',
    args: null,
    result: referenceData
  },

  getCandidateData: {
    tag: 'Кандидаты',
    summary: 'Активные кандидаты и статистика',
    description: 'Список активных кандидатов (не в архиве и не в корзине) и счётчики по статусам, архиву и корзине. Только чтение.',
    args: null,
    result: { type: 'object', properties: candidateDataProps }
  },

  getArchivedCandidateData: {
    tag: 'Кандидаты',
    summary: 'Кандидаты в архиве',
    description: 'Кандидаты в архиве (не в корзине), по номеру. Только чтение.',
    args: null,
    result: {
      type: 'object',
      properties: {
        archivedCandidates: { type: 'array', items: candidateSummary }
      }
    }
  },

  getDeletedCandidateData: {
    tag: 'Кандидаты',
    summary: 'Кандидаты в корзине',
    description: 'Кандидаты в корзине (удалены, но ещё не удалены окончательно — 30 дней), новые удаления первыми. Только чтение.',
    args: null,
    result: {
      type: 'object',
      properties: {
        deletedCandidates: { type: 'array', items: candidateSummary }
      }
    }
  },

  getCandidateDetails: {
    tag: 'Кандидаты',
    summary: 'Полная карточка кандидата',
    description:
      'Карточка кандидата с иными ссылками и всеми версиями резюме. Возвращает и архивных, и удалённых (см. `state`).\n\n' +
      'Ошибки: 404 «Кандидат не найден.» — неизвестный или некорректный ID.',
    args: uuidArg('ID кандидата.'),
    example: '00000000-0000-4000-8000-000000000001',
    result: candidateDetails
  },

  saveCandidate: {
    tag: 'Кандидаты',
    summary: 'Создать или изменить кандидата',
    description:
      'Без `ID` создаёт кандидата в статусе «Новый», с `ID` — изменяет существующего. Доступно любому авторизованному пользователю.\n\n' +
      '**Обязательно всегда** (и при изменении): `lastName`, `firstName`, `vacancyId`, `phone`, `recruiterId` (или устаревший `responsibleId`), ' +
      '`hrResponsibleId`, `techInterviewerId`. Необязательные поля при изменении, если не переданы, сохраняют текущие значения; ' +
      '`links` заменяется целиком, если передан массив.\n\n' +
      'Правила: при создании нужно резюме — `resumeFile` или `draftToken` черновика с файлом («Резюме обязательно.»); ' +
      'вакансия должна быть «Открыта» при создании или смене вакансии; рекрутер должен иметь доступ ко всем этапам, ' +
      'HR — к «HR screening», проф. интервьювер — к «Проф. интервью»; телефон — мобильный РК; ЗП ≤ 10 000 000; ' +
      'у иной ссылки нужны и название, и URL; кандидата в корзине менять нельзя.\n\n' +
      'Побочные эффекты: загрузка резюме в папку кандидата в Google Drive (папка создаётся при необходимости; при ошибке файлы убираются в корзину Drive); ' +
      'запись в журнал изменений; при создании — запись в журнал переходов, комментарий из `comment`, черновик помечается использованным; ' +
      'уведомления назначенным ответственным и подписчикам (кроме автора).\n\n' +
      'Ошибки: 400 — ошибка валидации, 404 — кандидат не найден.',
    args: {
      type: 'object',
      properties: {
        ID: { type: 'string', format: 'uuid', description: 'ID кандидата для изменения; не указывать при создании.' },
        lastName: { type: 'string', description: 'Фамилия.' },
        firstName: { type: 'string', description: 'Имя.' },
        middleName: { type: 'string', description: 'Отчество.' },
        vacancyId: { type: 'string', format: 'uuid', description: 'ID вакансии.' },
        phone: { type: 'string', description: 'Мобильный номер РК; приводится к «+7 7XX XXX XX XX».' },
        email: { type: 'string', description: 'Email; приводится к нижнему регистру.' },
        telegram: { type: 'string', description: 'Ссылка или username (5–32 символа, с «@» или без).' },
        linkedin: { type: 'string', description: 'URL или ник (дополняется до https://www.linkedin.com/in/...).' },
        github: { type: 'string', description: 'URL или ник (дополняется до https://github.com/...).' },
        sourceId: { type: ['string', 'null'], format: 'uuid', description: 'ID источника; пусто — без источника.' },
        salary: { type: ['string', 'number', 'null'], description: 'ЗП ожидания в тенге (0…10 000 000); пробелы допускаются, округляется до целого.' },
        recruiterId: { type: 'string', format: 'uuid', description: 'ID рекрутера (нужен он или responsibleId).' },
        responsibleId: { type: 'string', format: 'uuid', description: 'Устаревший синоним recruiterId.' },
        hrResponsibleId: { type: 'string', format: 'uuid', description: 'ID ответственного HR.' },
        techInterviewerId: { type: 'string', format: 'uuid', description: 'ID ответственного проф. интервьювера.' },
        links: { type: 'array', items: linkItem, description: 'Иные ссылки; пустые строки отбрасываются.' },
        resumeFile: {
          type: 'object',
          description: 'Новый файл резюме (PDF, DOC, DOCX, до 10 МБ); добавляется новой версией.',
          properties: {
            name: { type: 'string', description: 'Имя файла с расширением pdf/doc/docx.' },
            mimeType: { type: 'string', description: 'Не используется: тип определяется по расширению.' },
            base64: { type: 'string', description: 'Содержимое в base64 (допускается префикс data:...;base64,).' }
          },
          required: ['base64']
        },
        draftToken: { type: 'string', description: 'Только при создании: токен черновика; его резюме копируется кандидату, если resumeFile не передан.' },
        comment: { type: 'string', description: 'Только при создании: первый комментарий (HTML).' }
      },
      required: ['lastName', 'firstName', 'vacancyId', 'phone', 'hrResponsibleId', 'techInterviewerId']
    },
    example: {
      lastName: 'Иванов',
      firstName: 'Иван',
      middleName: 'Иванович',
      vacancyId: '00000000-0000-4000-8000-000000000010',
      phone: '+7 701 123 45 67',
      email: 'ivanov@example.com',
      telegram: '@ivanov_dev',
      sourceId: '00000000-0000-4000-8000-000000000020',
      salary: '800000',
      recruiterId: '00000000-0000-4000-8000-000000000031',
      hrResponsibleId: '00000000-0000-4000-8000-000000000032',
      techInterviewerId: '00000000-0000-4000-8000-000000000033',
      links: [{ name: 'Портфолио', url: 'https://example.com/ivanov' }],
      resumeFile: { name: 'Ivanov_CV.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK...' },
      comment: '<p>Откликнулся на hh.</p>'
    },
    result: okCandidate
  },

  archiveCandidate: {
    tag: 'Кандидаты',
    summary: 'Отправить кандидата в архив',
    description:
      'Ставит отметку архивации, текущий статус сохраняется. Если кандидат уже в архиве или в корзине — ничего не меняет и просто возвращает карточку.\n\n' +
      'Побочные эффекты (только при фактической архивации): запись в журнал изменений, уведомление назначенным и подписчикам.\n\n' +
      'Ошибки: 404 «Кандидат не найден.».',
    args: uuidArg('ID кандидата.'),
    example: '00000000-0000-4000-8000-000000000001',
    result: okCandidate
  },

  unarchiveCandidate: {
    tag: 'Кандидаты',
    summary: 'Вернуть кандидата из архива',
    description:
      'Снимает отметку архивации. Побочные эффекты: запись в журнал изменений, уведомление назначенным и подписчикам.\n\n' +
      'Ошибки: 404 «Кандидат не найден или находится в корзине.».',
    args: uuidArg('ID кандидата.'),
    example: '00000000-0000-4000-8000-000000000001',
    result: okCandidate
  },

  getAllowedTransitions: {
    tag: 'Кандидаты',
    summary: 'Этапы, на которые можно перевести кандидата',
    description:
      'Список этапов для перевода из текущего статуса (по таблице переходов). Для «Отказано» — только этап, с которого отказали. ' +
      'Пустой массив — кандидат не найден, в архиве или ID пустой. Некорректный UUID — 404.',
    args: uuidArg('ID кандидата.'),
    example: '00000000-0000-4000-8000-000000000001',
    result: {
      type: 'array',
      items: { type: 'string', enum: CANDIDATE_STATUSES },
      description: 'Разрешённые целевые этапы.'
    }
  },

  getCandidateTransitionStatusLog: {
    tag: 'Кандидаты',
    summary: 'Журнал переходов кандидата по этапам',
    description: 'История смены статусов кандидата по времени (включая создание). Некорректный ID — пустой массив. Только чтение.',
    args: uuidArg('ID кандидата.'),
    example: '00000000-0000-4000-8000-000000000001',
    result: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          'Transition ID': { type: 'string', format: 'uuid' },
          'Candidate ID': { type: 'string', format: 'uuid' },
          '№ кандидата': { type: ['integer', 'string'], description: 'Номер кандидата на момент перехода или пустая строка.' },
          'ФИО': { type: 'string', description: 'ФИО кандидата на момент перехода.' },
          'From Status': { type: 'string', description: 'Исходный этап; пустая строка при создании.' },
          'To Status': { type: 'string', enum: CANDIDATE_STATUSES },
          'Responsible ID': { type: 'string', description: 'ID ответственного за этап или пустая строка.' },
          'Ответственный': { type: 'string' },
          'Changed By User ID': { type: 'string', description: 'ID автора перехода или пустая строка.' },
          'Changed By': { type: 'string', description: 'Имя автора.' },
          'Changed By Email': { type: 'string' },
          'Комментарий': { type: 'string', description: 'Например, «Кандидат создан» или текст отказа.' },
          details: {
            type: ['object', 'null'],
            description: 'Доп. данные; при отказе — { rejection: { byType, byResponsibleId, byName, reason, comment } }.',
            additionalProperties: true
          },
          'Дата': dateTime('Дата перехода.')
        }
      }
    }
  },

  getCandidateDraft: {
    tag: 'Кандидаты',
    summary: 'Черновик кандидата по токену',
    description:
      'Возвращает данные черновика (создаются через MCP/API, живут 7 дней) для заполнения формы нового кандидата. Ничего не меняет.\n\n' +
      'Ошибки: 400 «Не указан token черновика.», 404 «Черновик кандидата не найден.», 400 «Черновик уже использован.», 400 «Срок действия черновика истёк.».',
    args: { type: 'string', description: 'Токен черновика (32 hex-символа, параметр ?draft= в ссылке).' },
    example: '3f2a9c1e5b7d4e8fa0b1c2d3e4f56789',
    result: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        data: {
          type: 'object',
          description: 'Поля формы из черновика (строки).',
          properties: {
            lastName: { type: 'string' },
            firstName: { type: 'string' },
            middleName: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
            telegram: { type: 'string' },
            github: { type: 'string' },
            linkedin: { type: 'string' },
            salary: { type: 'string' },
            vacancyId: { type: 'string' },
            sourceId: { type: 'string' },
            responsibleId: { type: 'string', description: 'ID рекрутера.' },
            comment: { type: 'string' },
            links: { type: 'array', items: linkItem }
          }
        },
        resume: {
          type: ['object', 'null'],
          description: 'Файл резюме черновика; null — без файла.',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            url: { type: 'string', description: 'Путь «/files/<id>» (с BASE_PATH).' }
          }
        },
        expiresAt: { type: 'string', format: 'date-time', description: 'Срок действия (ISO 8601).' }
      }
    }
  },

  parseResume: {
    tag: 'Кандидаты',
    summary: 'Разобрать файл резюме для автозаполнения формы',
    description:
      'Извлекает из резюме (PDF, DOC, DOCX, до 10 МБ) ФИО, контакты, профили, ЗП, подсказки вакансии/источника и ищет возможные дубли. ' +
      'Ничего не сохраняет. Уверенные значения — в `fields`, сомнительные — в `suggestions`.\n\n' +
      'Если в файле нет текста (скан) или это распечатка вакансии hh — возвращается `status` `scan` / `not_resume` с `message` и `fileHash`, без остальных полей.\n\n' +
      'Ошибки: 400 — файл не передан, неверный формат/размер, «Не удалось прочитать файл резюме: ...».',
    args: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя файла с расширением pdf/doc/docx.' },
        mimeType: { type: 'string', description: 'Не используется: тип определяется по расширению.' },
        base64: { type: 'string', description: 'Содержимое в base64 (допускается префикс data:...;base64,).' }
      },
      required: ['base64']
    },
    example: { name: 'Ivanov_CV.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK...' },
    result: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'scan', 'not_resume'] },
        message: { type: 'string', description: 'Только для scan / not_resume: пояснение.' },
        fileHash: { type: 'string', description: 'SHA-256 файла (hex).' },
        format: { type: 'string', enum: ['hh', 'enbek', 'linkedin', 'generic'], description: 'Распознанный формат резюме.' },
        formatLabel: { type: 'string', description: 'Название формата по-русски.' },
        fileName: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Уверенные значения по полям формы: lastName, firstName, middleName, email, phone, telegram, github, linkedin, salary (любые могут отсутствовать).',
          additionalProperties: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              confidence: { type: 'string', enum: ['high', 'medium'] },
              source: { type: 'string', description: 'Фрагмент резюме (до 120 символов), откуда взято значение.' }
            }
          }
        },
        suggestions: {
          type: 'array',
          description: 'Варианты для кнопки «Подставить».',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: ['name', 'email', 'phone', 'telegram', 'github', 'linkedin', 'salary'] },
              value: { type: ['string', 'object'], description: 'Значение; для name — { lastName, firstName, middleName }.' },
              label: { type: 'string', description: 'Текст для показа.' },
              note: { type: 'string', description: 'Почему это подсказка, а не значение.' }
            }
          }
        },
        warnings: stringList('Предупреждения разбора.'),
        links: { type: 'array', items: linkItem, description: 'Иные ссылки из резюме (до 6).' },
        position: { type: 'string', description: 'Желаемая должность.' },
        summary: stringList('Краткие факты: должность, город, опыт и т. п.'),
        hh: {
          type: ['object', 'null'],
          description: 'Только для формата hh: события откликов, комментарии, сопроводительное письмо.',
          properties: {
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', description: 'Тип события (отклик, приглашение, отказ).' },
                  vacancy: { type: 'string' },
                  date: { type: 'string', description: 'Дата вида «12 марта 2026» или пустая строка.' }
                }
              }
            },
            comments: {
              type: 'array',
              items: {
                type: 'object',
                properties: { date: { type: 'string' }, text: { type: 'string' }, author: { type: 'string' } }
              }
            },
            coverLetter: { type: 'string' }
          }
        },
        hints: {
          type: 'object',
          description: 'Подсказки по справочникам.',
          properties: {
            vacancy: {
              type: 'object',
              description: 'Подходящая открытая вакансия.',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium'] },
                reason: { type: 'string' }
              }
            },
            vacancyText: { type: 'string', description: 'Название вакансии из отклика hh, не найденной в ATS.' },
            source: {
              type: 'object',
              description: 'Источник по формату резюме.',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                confidence: { type: 'string', enum: ['high'] },
                reason: { type: 'string' }
              }
            }
          }
        },
        duplicates: {
          type: 'array',
          description: 'Возможные дубли — в формате ответа findSimilarCandidates.',
          items: { type: 'object', additionalProperties: true }
        }
      }
    }
  },

  findSimilarCandidates: {
    tag: 'Кандидаты',
    summary: 'Похожие кандидаты (проверка на дубль)',
    description:
      'Ищет среди всех кандидатов (включая архив и корзину) совпадения: ФИО — нечётко (транслитерация, ё/е, перестановка фамилии и имени), ' +
      'email, телефон и Telegram — точно. Возвращает до 5 лучших. Если нет ни ФИО (от 2 символов), ни email, ни телефона (от 10 цифр), ни Telegram — пустой массив. Только чтение.',
    args: {
      type: 'object',
      properties: {
        lastName: { type: 'string' },
        firstName: { type: 'string' },
        middleName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string', description: 'В любом формате; сравниваются цифры.' },
        telegram: { type: 'string', description: '@username или ссылка t.me.' },
        excludeId: { type: 'string', format: 'uuid', description: 'ID кандидата, которого исключить (при редактировании).' }
      }
    },
    example: {
      lastName: 'Иванов',
      firstName: 'Иван',
      phone: '87011234567',
      email: 'ivanov@example.com',
      excludeId: '00000000-0000-4000-8000-000000000001'
    },
    result: {
      type: 'array',
      description: 'По убыванию score, затем активные раньше архивных и удалённых, затем новые раньше.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          number: { type: 'integer', description: 'Номер кандидата.' },
          fullName: { type: 'string' },
          vacancy: { type: 'string', description: 'Название вакансии.' },
          status: { type: 'string', enum: CANDIDATE_STATUSES },
          state: { type: 'string', enum: ['active', 'archived', 'deleted'] },
          matchedBy: { type: 'array', items: { type: 'string', enum: ['email', 'phone', 'telegram', 'name'] } },
          nameScore: { type: 'number', minimum: 0, maximum: 1, description: 'Сходство ФИО (0 — не совпало, иначе ≥ 0.8).' },
          score: { type: 'number', minimum: 0, maximum: 1, description: '1 — совпал контакт или несколько признаков, иначе nameScore.' }
        }
      }
    }
  }
};
