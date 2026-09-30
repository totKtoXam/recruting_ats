// OpenAPI-описание RPC-методов: главная и аналитика, уведомления, интеграции профиля (MCP, Telegram).

// ---------- Общие фрагменты схем (без $ref — объекты подставляются как есть) ----------

const PERIOD_DAYS = [7, 30, 90];
const KIND_KEYS = ['assigned', 'candidate_changed', 'status_changed', 'stage_responsible'];
const CHANNEL_KEYS = ['app', 'email', 'telegram'];
const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'];
const DATETIME_LOCAL = 'Дата и время «YYYY-MM-DD HH:mm:ss» в часовом поясе приложения';

const periodArgs = {
  type: ['object', 'null'],
  properties: {
    days: {
      type: 'integer',
      enum: PERIOD_DAYS,
      default: 30,
      description: 'Длина периода в днях (включая сегодня). Любое другое значение заменяется на 30.'
    }
  }
};

const okResult = {
  type: 'object',
  properties: { ok: { type: 'boolean', enum: [true] } }
};

const candidateItem = {
  type: 'object',
  description: 'Кандидат в работе',
  properties: {
    id: { type: 'string', format: 'uuid' },
    number: { type: 'integer', description: 'Номер кандидата' },
    name: { type: 'string', description: 'ФИО' },
    status: { type: 'string', description: 'Текущий этап' },
    vacancy: { type: 'string', description: 'Название вакансии' },
    vacancyNumber: { type: 'integer', description: 'Номер вакансии' },
    recruiter: { type: 'string', description: 'ФИО рекрутера (пусто, если не назначен)' },
    stageSince: { type: 'string', description: `С какого момента на текущем этапе. ${DATETIME_LOCAL}` },
    days: { type: 'integer', description: 'Сколько полных дней на текущем этапе' }
  }
};

const candidateList = {
  type: 'object',
  properties: {
    total: { type: 'integer', description: 'Всего подходящих кандидатов (без учёта лимита)' },
    items: { type: 'array', items: candidateItem, description: 'Первые кандидаты, отсортированы по давности этапа' }
  }
};

const activityItem = {
  type: 'object',
  description: 'Запись журнала изменений',
  properties: {
    id: { type: 'string', format: 'uuid' },
    entityType: {
      type: 'string',
      enum: ['candidate', 'interview', 'vacancy', 'source', 'template', 'user'],
      description: 'Тип записи (user — только для администраторов)'
    },
    entityId: { type: 'string', format: 'uuid' },
    candidateId: { type: 'string', description: 'Кандидат, к которому относится запись (для candidate/interview), иначе пусто' },
    action: { type: 'string', description: 'Действие: create, update, revert и т. п.' },
    field: { type: 'string', description: 'Код изменённого поля' },
    fieldLabel: { type: 'string', description: 'Название поля' },
    oldDisplay: { type: 'string', description: 'Старое значение для показа' },
    newDisplay: { type: 'string', description: 'Новое значение для показа' },
    actorName: { type: 'string', description: 'Автор изменения («Система», если автора нет)' },
    entityLabel: { type: 'string', description: 'Имя записи (ФИО, название вакансии и т. п.)' },
    createdAt: { type: 'string', format: 'date-time' }
  }
};

const vacancyCounts = {
  type: 'object',
  description: 'Вакансии (не в архиве) по статусам',
  properties: {
    open: { type: 'integer', description: '«Открыта»' },
    paused: { type: 'integer', description: '«На паузе»' },
    closed: { type: 'integer', description: '«Закрыта»' }
  }
};

const pair = description => ({
  type: 'object',
  description,
  properties: {
    value: { type: 'integer', description: 'За текущий период' },
    previous: { type: 'integer', description: 'За предыдущий период той же длины' }
  }
});

const kpi = {
  type: 'object',
  description: 'Ключевые показатели: текущий и предыдущий период',
  properties: {
    created: pair('Новых кандидатов'),
    transitions: pair('Переходов по этапам'),
    hired: pair('Наймов (переходов в Hired)'),
    offers: pair('Офферов (переходов в Offer)'),
    rejected: pair('Отказов (переходов в «Отказано»)'),
    timeToHireDays: {
      type: 'object',
      description: 'Среднее время от создания кандидата до найма, дней (1 знак после запятой)',
      properties: {
        value: { type: ['number', 'null'] },
        previous: { type: ['number', 'null'] }
      }
    }
  }
};

const periodInfo = {
  type: 'object',
  properties: {
    days: { type: 'integer', enum: PERIOD_DAYS },
    from: { type: 'string', description: `Начало периода. ${DATETIME_LOCAL}` },
    to: { type: 'string', description: `Конец периода (сейчас). ${DATETIME_LOCAL}` },
    staleDays: { type: 'integer', description: 'Порог «без движения», дней (14)' }
  }
};

const series = {
  type: 'object',
  description: 'Ряд для графика: по дням (период до 31 дня) или по ISO-неделям',
  properties: {
    unit: { type: 'string', enum: ['day', 'week'] },
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'День «YYYY-MM-DD» или понедельник недели' },
          created: { type: 'integer', description: 'Новых кандидатов' },
          hired: { type: 'integer', description: 'Наймов' },
          rejected: { type: 'integer', description: 'Отказов' }
        }
      }
    }
  }
};

const sources = {
  type: 'array',
  description: 'Источники новых кандидатов за период (не более 7 строк; хвост свёрнут в «Другие»)',
  items: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'ID источника, пусто если не указан; у строки «Другие» отсутствует' },
      name: { type: 'string', description: 'Название («Не указан» / «Другие»)' },
      count: { type: 'integer', description: 'Кандидатов' },
      hired: { type: 'integer', description: 'Из них сейчас в статусе Hired' },
      other: { type: 'boolean', description: 'true у свёрнутой строки «Другие»' }
    }
  }
};

const rejections = {
  type: 'object',
  description: 'Отказы за период',
  properties: {
    total: { type: 'integer' },
    byCandidate: { type: 'integer', description: 'Отказался кандидат' },
    byCompany: { type: 'integer', description: 'Отказала компания' },
    reasons: {
      type: 'array',
      description: 'Причины (не более 6 строк; хвост свёрнут в «Другие»)',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Причина («Причина не указана», если пусто)' },
          count: { type: 'integer' },
          other: { type: 'boolean', description: 'true у строки «Другие»' }
        }
      }
    }
  }
};

const cohort = {
  type: 'array',
  description: 'Конверсия: сколько кандидатов, созданных за период, дошли до каждого этапа воронки',
  items: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['Новый', 'HR screening', 'Проф. интервью', 'Финальное интервью', 'Offer', 'Hired'] },
      count: { type: 'integer' }
    }
  }
};

const workload = {
  type: 'array',
  description: 'Нагрузка рекрутеров (до 8 человек, по убыванию кандидатов в работе)',
  items: {
    type: 'object',
    properties: {
      userId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      inProgress: { type: 'integer', description: 'Кандидатов в работе' },
      offers: { type: 'integer', description: 'На этапе Offer' },
      total: { type: 'integer', description: 'Всего активных кандидатов' }
    }
  }
};

const notification = {
  type: 'object',
  description: 'Уведомление',
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: KIND_KEYS, description: 'Вид уведомления' },
    kindLabel: { type: 'string', description: 'Название вида' },
    title: { type: 'string' },
    body: { type: 'string' },
    details: {
      type: 'object',
      description: 'Подробности: actor, vacancy, status и, в зависимости от вида, roles, fromStatus, toStatus, changes',
      additionalProperties: true
    },
    actorName: { type: 'string', description: 'Автор изменения' },
    candidateId: { type: 'string', description: 'ID кандидата или пусто' },
    candidateNumber: { type: ['integer', 'null'], description: 'Номер кандидата' },
    candidateState: {
      type: 'string',
      enum: ['active', 'archived', 'deleted', 'missing'],
      description: 'Состояние карточки кандидата сейчас'
    },
    inApp: { type: 'boolean', description: 'Показывается в колокольчике (включён канал app)' },
    important: { type: 'boolean', description: 'Отмечено важным' },
    read: { type: 'boolean' },
    readAt: { type: 'string', description: 'Когда прочитано (ISO 8601) или пусто' },
    createdAt: { type: 'string', format: 'date-time' },
    channels: {
      type: 'array',
      description: 'Доставка по каналам (app — всегда sent)',
      items: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: CHANNEL_KEYS },
          status: { type: 'string', enum: DELIVERY_STATUSES },
          recipient: { type: 'string', description: 'Email или @ник Telegram' },
          attempts: { type: 'integer' },
          error: { type: 'string', description: 'Ошибка или причина пропуска' },
          sentAt: { type: 'string', description: 'Когда отправлено (ISO 8601) или пусто' },
          updatedAt: { type: 'string', description: 'Когда обновлена строка доставки (отсутствует у app)' }
        }
      }
    }
  }
};

const uuidArg = description => ({ type: 'string', format: 'uuid', description });

// ---------- Методы ----------

export default {
  // ===== Главная и аналитика =====

  getHomeData: {
    tag: 'Главная и аналитика',
    summary: 'Главная «Мой день»: очередь, зависшие, вакансии, события',
    description:
      'Текущее состояние без периода: моя очередь (кандидаты на моём этапе), кандидаты без движения дольше 14 дней, ' +
      'незакрытые вакансии с разбивкой по этапам, последние события журнала и число непрочитанных уведомлений.\n\n' +
      '- Доступно любому пользователю.\n' +
      '- «Мой этап»: HR screening — ответственный HR, Проф. интервью — проф. интервьювер, остальные этапы — рекрутер.\n' +
      '- События с записями пользователей (`entityType: user`) видят только администраторы.\n' +
      '- Только чтение.',
    args: null,
    result: {
      type: 'object',
      properties: {
        generatedAt: { type: 'string', format: 'date-time' },
        focus: {
          type: 'string',
          enum: ['team', 'personal'],
          description: 'personal — интервьюер, отвечающий за часть этапов; team — админ, рекрутер (все этапы) или без этапов'
        },
        staleDays: { type: 'integer', description: 'Порог «без движения», дней (14)' },
        freshDays: { type: 'integer', description: 'Окно «новых» кандидатов в вакансиях, дней (7)' },
        totals: {
          type: 'object',
          description: 'Активные кандидаты',
          properties: {
            inProgress: { type: 'integer', description: 'В работе (не Hired и не «Отказано»)' },
            offers: { type: 'integer', description: 'На этапе Offer' },
            hired: { type: 'integer', description: 'Hired' }
          }
        },
        my: {
          type: 'object',
          description: 'Моя очередь (до 50 кандидатов)',
          properties: {
            mine: { type: 'integer', description: 'Кандидатов в работе, где я назначен в любой роли' },
            total: candidateList.properties.total,
            items: candidateList.properties.items
          }
        },
        stale: { ...candidateList, description: 'Без движения дольше staleDays (до 50)' },
        vacancies: {
          type: 'object',
          properties: {
            counts: vacancyCounts,
            items: {
              type: 'array',
              description: 'Открытые и на паузе (до 12)',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  number: { type: 'integer' },
                  name: { type: 'string' },
                  status: { type: 'string', enum: ['Открыта', 'На паузе'] },
                  stages: {
                    type: 'object',
                    description: 'Активные кандидаты по статусам: { "<статус>": число }',
                    additionalProperties: { type: 'integer' }
                  },
                  inProgress: { type: 'integer', description: 'Кандидатов в работе' },
                  fresh: { type: 'integer', description: 'Новых за freshDays дней' },
                  daysOpen: { type: 'integer', description: 'Дней с создания вакансии' }
                }
              }
            }
          }
        },
        activity: { type: 'array', items: activityItem, description: 'Последние 6 событий журнала' },
        notificationsUnread: { type: 'integer', description: 'Непрочитанных уведомлений в колокольчике' }
      }
    }
  },

  getAnalyticsData: {
    tag: 'Главная и аналитика',
    summary: 'Страница «Аналитика»: показатели за период и нагрузка',
    description:
      'Показатели за последние `days` дней (включая сегодня) в сравнении с предыдущим периодом той же длины: KPI, ' +
      'ряд по дням/неделям, конверсия по этапам, источники, причины отказов; а также текущие итоги и нагрузка рекрутеров.\n\n' +
      '- Доступно любому пользователю. Только чтение.\n' +
      '- Удалённые (в корзине) кандидаты не учитываются.',
    args: periodArgs,
    example: { days: 30 },
    result: {
      type: 'object',
      properties: {
        days: { type: 'integer', enum: PERIOD_DAYS },
        period: periodInfo,
        kpi,
        series,
        cohort,
        sources,
        rejections,
        generatedAt: { type: 'string', format: 'date-time' },
        totals: {
          type: 'object',
          properties: {
            inProgress: { type: 'integer' },
            offers: { type: 'integer' },
            hired: { type: 'integer' }
          }
        },
        workload
      }
    }
  },

  getDashboardData: {
    tag: 'Главная и аналитика',
    summary: 'Полная сводка по найму (формат MCP-инструмента get_dashboard)',
    description:
      'Всё сразу: итоги, KPI за период, воронка, ряд, источники, отказы, вакансии, зависшие, моя очередь, ' +
      'последние кандидаты, нагрузка, события и непрочитанные уведомления.\n\n' +
      '- Доступно любому пользователю. Только чтение.\n' +
      '- `totals.deleted` — только для администраторов, остальным `null`; события по пользователям видят только администраторы.',
    args: periodArgs,
    example: { days: 7 },
    result: {
      type: 'object',
      properties: {
        days: { type: 'integer', enum: PERIOD_DAYS },
        period: periodInfo,
        generatedAt: { type: 'string', format: 'date-time' },
        totals: {
          type: 'object',
          properties: {
            active: { type: 'integer', description: 'Активных кандидатов (не архив, не корзина)' },
            inProgress: { type: 'integer' },
            hired: { type: 'integer' },
            rejected: { type: 'integer' },
            archived: { type: 'integer' },
            deleted: { type: ['integer', 'null'], description: 'В корзине; null для не-администраторов' }
          }
        },
        kpi,
        funnel: {
          type: 'array',
          description: 'Активные кандидаты по статусам в порядке воронки + «Отказано»; неизвестные статусы — в конце',
          items: {
            type: 'object',
            properties: { status: { type: 'string' }, count: { type: 'integer' } }
          }
        },
        series,
        sources,
        rejections,
        vacancies: {
          type: 'object',
          properties: {
            counts: vacancyCounts,
            items: {
              type: 'array',
              description: 'До 8 вакансий (открытые, на паузе, закрытые)',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  number: { type: 'integer' },
                  name: { type: 'string' },
                  status: { type: 'string', enum: ['Открыта', 'На паузе', 'Закрыта'] },
                  inProgress: { type: 'integer' },
                  offers: { type: 'integer' },
                  hired: { type: 'integer' },
                  created: { type: 'integer', description: 'Новых кандидатов за период' },
                  daysOpen: { type: 'integer' }
                }
              }
            }
          }
        },
        stale: {
          type: 'object',
          description: 'Без движения (до 8)',
          properties: {
            thresholdDays: { type: 'integer', description: 'Порог, дней (14)' },
            total: candidateList.properties.total,
            items: candidateList.properties.items
          }
        },
        my: {
          type: 'object',
          properties: {
            mine: { type: 'integer', description: 'Кандидатов в работе, где я назначен' },
            queueTotal: { type: 'integer', description: 'Всего в моей очереди' },
            queue: { type: 'array', items: candidateItem, description: 'Моя очередь (до 8)' }
          }
        },
        recent: {
          type: 'array',
          description: 'Последние 6 созданных кандидатов (включая архивных)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              number: { type: 'integer' },
              name: { type: 'string' },
              status: { type: 'string' },
              vacancy: { type: 'string' },
              vacancyNumber: { type: 'integer' },
              source: { type: 'string' },
              createdAt: { type: 'string', description: DATETIME_LOCAL },
              archived: { type: 'boolean' }
            }
          }
        },
        workload,
        activity: { type: 'array', items: activityItem, description: 'Последние 12 событий журнала' },
        notificationsUnread: { type: 'integer' }
      }
    }
  },

  // ===== Уведомления =====

  getNotificationFeed: {
    tag: 'Уведомления',
    summary: 'Лента колокольчика (уведомления канала «В приложении»)',
    description:
      'Свои уведомления с включённым каналом `app`, новые сверху, с курсорной пагинацией по `before`.\n\n' +
      '- Неизвестный `view` работает как `recent`; `limit` приводится к диапазону 1–50; некорректная дата `before` игнорируется.\n' +
      '- Только чтение.',
    args: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['recent', 'unread', 'important'],
          default: 'recent',
          description: 'recent — все, unread — непрочитанные, important — важные'
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Размер страницы' },
        before: {
          type: 'string',
          format: 'date-time',
          description: 'Курсор: вернуть уведомления, созданные раньше этого момента (createdAt последнего элемента)'
        }
      }
    },
    example: { view: 'unread', limit: 20, before: '2026-09-29T10:15:00.000Z' },
    result: {
      type: 'object',
      properties: {
        items: { type: 'array', items: notification },
        hasMore: { type: 'boolean', description: 'Есть ещё более старые' },
        unread: { type: 'integer', description: 'Непрочитанных в колокольчике' }
      }
    }
  },

  getNotificationUnread: {
    tag: 'Уведомления',
    summary: 'Число непрочитанных уведомлений в колокольчике',
    description: 'Считает непрочитанные уведомления текущего пользователя с каналом `app`. Только чтение.',
    args: null,
    result: {
      type: 'object',
      properties: { unread: { type: 'integer' } }
    }
  },

  getNotification: {
    tag: 'Уведомления',
    summary: 'Одно уведомление с состоянием доставки по каналам',
    description:
      'Возвращает своё уведомление по ID. Чужое, несуществующее или некорректный ID — 404 «Уведомление не найдено.». ' +
      'Прочитанным не отмечает.',
    args: uuidArg('ID уведомления'),
    example: '00000000-0000-4000-8000-000000000001',
    result: notification
  },

  markNotificationRead: {
    tag: 'Уведомления',
    summary: 'Отметить уведомление прочитанным или непрочитанным',
    description:
      'Меняет отметку прочтения своего уведомления (при повторной отметке время прочтения не меняется). ' +
      'Чужое или несуществующее — 404 «Уведомление не найдено.».',
    args: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', description: 'ID уведомления' },
        read: { type: 'boolean', default: true, description: 'false — снова сделать непрочитанным' }
      },
      required: ['id']
    },
    example: { id: '00000000-0000-4000-8000-000000000001', read: true },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', enum: [true] },
        unread: { type: 'integer', description: 'Непрочитанных в колокольчике после изменения' }
      }
    }
  },

  markAllNotificationsRead: {
    tag: 'Уведомления',
    summary: 'Отметить все уведомления прочитанными',
    description: 'Отмечает прочитанными все непрочитанные уведомления текущего пользователя (по всем каналам). Аргументы не используются.',
    args: null,
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', enum: [true] },
        unread: { type: 'integer', enum: [0] }
      }
    }
  },

  setNotificationImportant: {
    tag: 'Уведомления',
    summary: 'Отметить уведомление важным или снять отметку',
    description:
      'Важные уведомления не удаляются автоматической очисткой (обычные удаляются через 180 дней). ' +
      'Чужое или несуществующее уведомление — 404 «Уведомление не найдено.».',
    args: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', description: 'ID уведомления' },
        important: { type: 'boolean', default: true, description: 'false — снять отметку' }
      },
      required: ['id']
    },
    example: { id: '00000000-0000-4000-8000-000000000001', important: true },
    result: okResult
  },

  listNotificationLog: {
    tag: 'Уведомления',
    summary: 'Журнал своих уведомлений: фильтры, сортировка, страницы',
    description:
      'Серверная таблица всех своих уведомлений (включая не показанные в колокольчике) с состоянием доставки.\n\n' +
      '- Неизвестные ключи фильтров/сортировки и значения вне списка игнорируются.\n' +
      '- `pageSize` приводится к 1–100; если страниц меньше, чем `page`, возвращается последняя.\n' +
      '- По умолчанию сортировка `createdAt` по убыванию. Только чтение.',
    args: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        sort: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: ['createdAt', 'kind', 'title', 'actor', 'read', 'important'] },
            dir: { type: 'string', enum: ['asc', 'desc'], description: 'Всё, кроме desc, трактуется как asc' }
          }
        },
        filters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Подстрока в заголовке, тексте или авторе (без учёта регистра)' },
            kind: { type: 'string', enum: KIND_KEYS },
            read: { type: 'string', enum: ['read', 'unread'] },
            important: { type: 'string', enum: ['yes', 'no'] },
            delivery: {
              type: 'string',
              enum: ['failed', 'pending', 'sent', 'skipped', 'app'],
              description: 'Сводный статус внешней доставки; app — только в приложении, без внешних каналов'
            }
          }
        }
      }
    },
    example: {
      page: 1,
      pageSize: 20,
      sort: { key: 'createdAt', dir: 'desc' },
      filters: { kind: 'status_changed', read: 'unread', delivery: 'failed' }
    },
    result: {
      type: 'object',
      properties: {
        items: { type: 'array', items: notification },
        state: { type: 'string', description: 'Служебное поле серверных таблиц; для журнала не влияет на выборку' },
        counts: { type: 'null', description: 'Для журнала всегда null' },
        total: { type: 'integer', description: 'Всего записей с учётом фильтров' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        sort: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            dir: { type: 'string', enum: ['asc', 'desc'] }
          }
        }
      }
    }
  },

  getNotificationSettings: {
    tag: 'Уведомления',
    summary: 'Настройки уведомлений текущего пользователя',
    description:
      'Справочник видов и каналов, доступность каналов (настроены ли SMTP/Telegram-бот, есть ли email, привязан ли Telegram), ' +
      'матрица включённых каналов и состояние привязки Telegram. Аргументы не используются.\n\n' +
      'Значения по умолчанию: в приложении включено всё; `candidate_changed` по email и Telegram выключен.',
    args: null,
    result: {
      type: 'object',
      properties: {
        kinds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: KIND_KEYS },
              label: { type: 'string' },
              description: { type: 'string' }
            }
          }
        },
        channels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: CHANNEL_KEYS },
              label: { type: 'string' },
              available: { type: 'boolean', description: 'Канал может доставлять этому пользователю' },
              reason: { type: 'string', description: 'Почему недоступен (пусто, если доступен)' }
            }
          }
        },
        preferences: {
          type: 'object',
          description: 'Матрица { <вид>: { app, email, telegram: boolean } } для всех четырёх видов',
          additionalProperties: {
            type: 'object',
            properties: {
              app: { type: 'boolean' },
              email: { type: 'boolean' },
              telegram: { type: 'boolean' }
            }
          }
        },
        mutedChannels: {
          type: 'array',
          items: { type: 'string', enum: CHANNEL_KEYS },
          description: 'Каналы, выключенные целиком (отметки матрицы по ним сохраняются, но не действуют)'
        },
        mutedKinds: {
          type: 'array',
          items: { type: 'string', enum: KIND_KEYS },
          description: 'Виды уведомлений, выключенные целиком'
        },
        email: { type: 'string', description: 'Email пользователя (пусто, если не указан)' },
        telegram: {
          type: 'object',
          properties: {
            botConfigured: { type: 'boolean', description: 'Токен бота задан администратором' },
            botUsername: { type: 'string', description: 'Ник бота (пусто, если бот недоступен)' },
            username: { type: 'string', description: 'Telegram-ник пользователя без @' },
            linked: { type: 'boolean', description: 'Чат привязан — бот может писать' },
            verifiedAt: { type: 'string', description: 'Когда привязан (ISO 8601) или пусто' }
          }
        }
      }
    }
  },

  setNotificationPreference: {
    tag: 'Уведомления',
    summary: 'Включить или выключить один канал для одного вида',
    description:
      'Сохраняет настройку текущего пользователя. Неизвестный вид — 400 «Неизвестный вид уведомления.», ' +
      'неизвестный канал — 400 «Неизвестный канал.». `enabled` приводится к boolean (отсутствует → false).',
    args: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KIND_KEYS },
        channel: { type: 'string', enum: CHANNEL_KEYS },
        enabled: { type: 'boolean' }
      },
      required: ['kind', 'channel']
    },
    example: { kind: 'candidate_changed', channel: 'email', enabled: true },
    result: okResult
  },

  setNotificationPreferences: {
    tag: 'Уведомления',
    summary: 'Сохранить несколько настроек уведомлений разом',
    description:
      'Пакетное сохранение в одной транзакции (например, все виды по одному каналу).\n\n' +
      '- Пустой список или больше 12 элементов — 400 «Нет изменений.».\n' +
      '- Любой неизвестный вид или канал — 400 «Неизвестный вид или канал.», ничего не сохраняется.',
    args: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: KIND_KEYS },
              channel: { type: 'string', enum: CHANNEL_KEYS },
              enabled: { type: 'boolean' }
            },
            required: ['kind', 'channel']
          }
        }
      },
      required: ['items']
    },
    example: {
      items: [
        { kind: 'assigned', channel: 'telegram', enabled: true },
        { kind: 'status_changed', channel: 'telegram', enabled: true },
        { kind: 'stage_responsible', channel: 'telegram', enabled: false }
      ]
    },
    result: okResult
  },

  setNotificationSwitch: {
    tag: 'Уведомления',
    summary: 'Включить или выключить канал либо вид уведомлений целиком',
    description:
      'Общий выключатель текущего пользователя поверх матрицы «вид × канал»: `scope: "channel"` — канал целиком ' +
      '(`key` — app, email, telegram), `scope: "kind"` — вид целиком. Отметки матрицы не меняются: после повторного ' +
      'включения действуют прежние.\n\n' +
      '- Неизвестный `scope` — 400 «Неизвестный выключатель.».\n' +
      '- Неизвестный канал — 400 «Неизвестный канал.», неизвестный вид — 400 «Неизвестный вид уведомления.».',
    args: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['channel', 'kind'] },
        key: { type: 'string', enum: [...CHANNEL_KEYS, ...KIND_KEYS] },
        enabled: { type: 'boolean' }
      },
      required: ['scope', 'key']
    },
    example: { scope: 'channel', key: 'email', enabled: false },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        mutedChannels: { type: 'array', items: { type: 'string', enum: CHANNEL_KEYS } },
        mutedKinds: { type: 'array', items: { type: 'string', enum: KIND_KEYS } }
      }
    }
  },

  getCandidateWatch: {
    tag: 'Уведомления',
    summary: 'Слежу ли я за кандидатом и сколько всего следящих',
    description:
      'Состояние подписки «Следить» текущего пользователя на кандидата. Несуществующий кандидат или некорректный ID — ' +
      '404 «Кандидат не найден.» (кандидаты в архиве и корзине тоже находятся).',
    args: uuidArg('ID кандидата'),
    example: '00000000-0000-4000-8000-000000000002',
    result: {
      type: 'object',
      properties: {
        watching: { type: 'boolean', description: 'Текущий пользователь следит' },
        watchers: { type: 'integer', description: 'Всего следящих' }
      }
    }
  },

  setCandidateWatch: {
    tag: 'Уведомления',
    summary: 'Подписаться на кандидата или отписаться',
    description:
      'Следящие получают уведомления «Изменения в карточке» и «Перенос карточки» по этому кандидату. Повторная подписка/отписка ' +
      'не ошибка. Несуществующий кандидат — 404 «Кандидат не найден.».',
    args: {
      type: 'object',
      properties: {
        candidateId: { type: 'string', format: 'uuid', description: 'ID кандидата' },
        watch: { type: 'boolean', default: true, description: 'false — отписаться' }
      },
      required: ['candidateId']
    },
    example: { candidateId: '00000000-0000-4000-8000-000000000002', watch: true },
    result: {
      type: 'object',
      properties: {
        watching: { type: 'boolean' },
        watchers: { type: 'integer' }
      }
    }
  },

  // ===== Интеграции профиля =====

  listMcpConnections: {
    tag: 'Интеграции профиля',
    summary: 'Мои MCP-подключения (OAuth) и личные токены',
    description:
      'Действующие OAuth-подключения MCP-клиентов (не отозваны, refresh-токен не истёк) и действующие личные токены ' +
      'текущего пользователя. Сами токены не возвращаются — только префикс. Аргументы не используются.',
    args: null,
    result: {
      type: 'object',
      properties: {
        connections: {
          type: 'array',
          description: 'OAuth-подключения, недавно использованные сверху',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              clientName: { type: 'string', description: 'Имя клиента («MCP-клиент», если не указано)' },
              createdAt: { type: 'string', description: DATETIME_LOCAL },
              lastUsedAt: { type: ['string', 'null'], description: DATETIME_LOCAL }
            }
          }
        },
        tokens: {
          type: 'array',
          description: 'Личные токены, новые сверху',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              prefix: { type: 'string', description: 'Начало токена для узнавания, например «atsp_Ab12Cd»' },
              createdAt: { type: 'string', description: DATETIME_LOCAL },
              lastUsedAt: { type: ['string', 'null'], description: DATETIME_LOCAL },
              expiresAt: { type: ['string', 'null'], description: `${DATETIME_LOCAL}; null — бессрочный` }
            }
          }
        }
      }
    }
  },

  revokeMcpConnection: {
    tag: 'Интеграции профиля',
    summary: 'Отключить OAuth-подключение MCP-клиента',
    description:
      'Отзывает своё OAuth-подключение: access- и refresh-токены клиента перестают действовать сразу. ' +
      'Некорректный ID — 400 «Некорректный идентификатор.»; чужое, уже отозванное или несуществующее — 404 «Подключение не найдено.».',
    args: uuidArg('ID подключения из listMcpConnections.connections'),
    example: '00000000-0000-4000-8000-000000000003',
    result: okResult
  },

  createMcpToken: {
    tag: 'Интеграции профиля',
    summary: 'Выпустить личный токен для MCP-клиента',
    description:
      'Создаёт личный токен (`atsp_…`), который MCP-клиент передаёт в заголовке `Authorization: Bearer`, когда не может пройти OAuth.\n\n' +
      '- **Токен в открытом виде возвращается только один раз** — в БД хранится лишь его SHA-256 и префикс.\n' +
      '- Не больше 10 действующих токенов на пользователя, иначе 400.\n' +
      '- `name` обрезается до 80 символов (пусто → «Claude»); `expiresInDays` вне списка → 90.',
    args: {
      type: ['object', 'null'],
      properties: {
        name: { type: 'string', maxLength: 80, default: 'Claude', description: 'Подпись токена' },
        expiresInDays: {
          type: 'integer',
          enum: [30, 90, 365, 0],
          default: 90,
          description: 'Срок действия в днях; 0 — бессрочный'
        }
      }
    },
    example: { name: 'Claude Code (ноутбук)', expiresInDays: 90 },
    result: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        token: { type: 'string', description: 'Токен целиком (atsp_…). Показывается один раз, повторно получить нельзя' },
        expiresAt: { type: ['string', 'null'], description: `${DATETIME_LOCAL}; null — бессрочный` }
      }
    }
  },

  revokeMcpToken: {
    tag: 'Интеграции профиля',
    summary: 'Отозвать личный токен',
    description:
      'Отзывает свой личный токен — он перестаёт действовать сразу. Некорректный ID — 400 «Некорректный идентификатор.»; ' +
      'чужой, уже отозванный или несуществующий — 404 «Токен не найден.».',
    args: uuidArg('ID токена из listMcpConnections.tokens'),
    example: '00000000-0000-4000-8000-000000000004',
    result: okResult
  },

  createTelegramLink: {
    tag: 'Интеграции профиля',
    summary: 'Получить ссылку для привязки Telegram',
    description:
      'Выдаёт одноразовую ссылку `t.me/<бот>?start=<код>` на 15 минут. После нажатия «Старт» в боте аккаунт Telegram ' +
      'привязывается к текущему пользователю (прежний код перезаписывается). Аргументы не используются.\n\n' +
      '- Бот не настроен — 400 «Telegram-бот не настроен…»; бот недоступен — 400 «Telegram-бот сейчас недоступен…».',
    args: null,
    result: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Ссылка на бота с кодом привязки' },
        expiresAt: { type: 'string', format: 'date-time', description: 'Когда ссылка перестанет действовать' }
      }
    }
  },

  unlinkTelegram: {
    tag: 'Интеграции профиля',
    summary: 'Отвязать Telegram',
    description:
      'Отвязывает чат Telegram текущего пользователя и сбрасывает неиспользованный код привязки; уведомления в Telegram ' +
      'больше не доставляются (ник сохраняется). Повторный вызов не ошибка. Аргументы не используются.',
    args: null,
    result: okResult
  }
};
