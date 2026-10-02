// OpenAPI-описание RPC-методов: интервью и этапы, жизненный цикл записей, журнал изменений, комментарии.

const STAGES = ['Новый', 'HR screening', 'Проф. интервью', 'Финальное интервью', 'Offer', 'Hired'];
const STATUSES = [...STAGES, 'Отказано'];
const LIFECYCLE_TYPES = ['candidate', 'vacancy', 'source', 'template', 'vacancy_preset', 'interview', 'user'];
const COMMENT_ENTITY_TYPES = ['candidate', 'vacancy', 'interview'];
const REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '👀'];

const uuid = description => ({ type: 'string', format: 'uuid', description });
const dateTime = description => ({
  type: 'string',
  description: `${description} Формат «yyyy-MM-dd HH:mm:ss» в часовом поясе приложения; пустая строка — нет значения.`
});
const richText = description => ({
  type: 'string',
  maxLength: 50000,
  description: `${description} Форматированный текст (HTML) — очищается по белому списку тегов; обычный текст экранируется и оборачивается в <p>.`
});

const lifecycleProps = {
  'Дата создания': dateTime('Дата создания.'),
  'Дата изменения': dateTime('Дата последнего изменения.'),
  state: { type: 'string', enum: ['active', 'archived', 'deleted'], description: 'Состояние записи.' },
  archivedAt: dateTime('Когда отправлена в архив.'),
  deletedAt: dateTime('Когда удалена в корзину.'),
  purgeAt: dateTime('Когда будет окончательно удалена из корзины.'),
  daysUntilPurge: { type: ['integer', 'null'], description: 'Дней до окончательного удаления; null — запись не в корзине.' }
};

const answerItem = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'Текст вопроса.' },
    answer: { type: 'string', description: 'Ответ (HTML); пустая строка, если вопрос пропущен.' },
    skipped: { type: 'boolean', description: 'Есть только у пропущенного вопроса (true).' }
  }
};

const interviewSchema = {
  type: 'object',
  description: 'Результат этапа (интервью).',
  properties: {
    'Interview ID': uuid('ID результата интервью.'),
    'Candidate ID': uuid('ID кандидата.'),
    'Фамилия кандидата': { type: 'string' },
    'Имя кандидата': { type: 'string' },
    'Отчество кандидата': { type: 'string' },
    'ФИО': { type: 'string', description: 'ФИО кандидата.' },
    'Vacancy ID': uuid('ID вакансии.'),
    'Вакансия': { type: 'string', description: 'Название вакансии.' },
    'Этап': { type: 'string', enum: STAGES, description: 'Этап, результат которого записан (совпадает с To Status).' },
    'From Status': { type: 'string', enum: STATUSES, description: 'Этап, с которого перевели.' },
    'To Status': { type: 'string', enum: STAGES, description: 'Этап, на который перевели.' },
    'Template ID': { type: 'string', description: 'ID шаблона вопросов; пустая строка — без шаблона.' },
    'Шаблон': { type: 'string', description: 'Название шаблона на момент перехода.' },
    'Дата': dateTime('Дата создания результата.'),
    'Фамилия интервьюера': { type: 'string' },
    'Имя интервьюера': { type: 'string' },
    'Отчество интервьюера': { type: 'string' },
    'Интервьюер': { type: 'string', description: 'ФИО ответственного за этап.' },
    'Responsible ID': { type: 'string', description: 'ID ответственного за этап (пользователя).' },
    'Вопросы и ответы': { type: 'string', description: 'То же, что answers, сериализованное в JSON-строку.' },
    'Результат': { type: 'string', description: 'Итог этапа (HTML).' },
    answers: { type: 'array', items: answerItem, description: 'Ответы на вопросы шаблона.' },
    ...lifecycleProps
  }
};

const candidateSchema = {
  type: 'object',
  additionalProperties: true,
  description:
    'Полная карточка кандидата (как в getCandidateDetails): ключи «ID», «ФИО», «Статус», «Vacancy ID», ' +
    'ответственные, контакты, rejection, resumeVersions, links, state и др.'
};

const templateSchema = {
  type: 'object',
  description: 'Шаблон вопросов, привязанный к вакансии и этапу.',
  properties: {
    'Template ID': uuid('ID шаблона.'),
    '№': { type: 'integer', description: 'Порядковый номер шаблона.' },
    'Название': { type: 'string' },
    'Вопросы': { type: 'string', description: 'То же, что questions, в виде JSON-строки.' },
    questions: {
      type: 'array',
      description: 'Вопросы в порядке, в котором ожидаются ответы.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Текст вопроса.' },
          answers: { type: 'array', items: { type: 'string' }, description: 'Предпочтительные/вероятные ответы.' }
        }
      }
    },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', enum: ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'gray'] }
        }
      }
    },
    'Vacancy ID': uuid('Вакансия привязки.'),
    'Этап': { type: 'string', enum: STAGES, description: 'Этап привязки.' },
    'Обязательный': { type: 'boolean', description: 'Шаблон обязателен при переходе на этап.' },
    required: { type: 'boolean', description: 'То же, что «Обязательный».' },
    ...lifecycleProps
  }
};

const okSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean', const: true } },
  required: ['ok']
};

const lifecycleArgs = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: LIFECYCLE_TYPES, description: 'Тип записи.' },
    id: uuid('ID записи.')
  },
  required: ['type', 'id']
};

const reactionsSchema = {
  type: 'array',
  description: 'Реакции, сгруппированные по эмодзи (в порядке списка поддерживаемых реакций).',
  items: {
    type: 'object',
    properties: {
      emoji: { type: 'string', enum: REACTIONS },
      count: { type: 'integer', description: 'Сколько пользователей поставили реакцию.' },
      mine: { type: 'boolean', description: 'Реакцию поставил текущий пользователь.' },
      users: { type: 'array', items: { type: 'string' }, description: 'Имена (или email) поставивших.' }
    }
  }
};

const commentSchema = {
  type: 'object',
  properties: {
    id: uuid('ID комментария.'),
    parentId: { type: ['string', 'null'], format: 'uuid', description: 'ID родительского комментария; null — комментарий верхнего уровня.' },
    author: {
      type: 'object',
      description: 'Автор. Если пользователь удалён — id: null и сохранённое имя.',
      properties: {
        id: { type: ['string', 'null'], format: 'uuid' },
        name: { type: 'string' },
        email: { type: 'string' },
        avatarUrl: { type: 'string' }
      }
    },
    bodyHtml: { type: 'string', description: 'Текст комментария (очищенный HTML).' },
    createdAt: { type: 'string', format: 'date-time', description: 'Дата создания (ISO 8601).' },
    updatedAt: { type: ['string', 'null'], format: 'date-time', description: 'Дата редактирования (ISO 8601); null — не редактировался.' },
    edited: { type: 'boolean', description: 'Комментарий редактировался.' },
    reactions: reactionsSchema,
    canEdit: { type: 'boolean', description: 'Текущий пользователь — автор.' },
    canDelete: { type: 'boolean', description: 'Текущий пользователь — автор или администратор.' }
  }
};

export default {
  getInterviews: {
    tag: 'Интервью и этапы',
    summary: 'Результаты этапов (интервью) кандидата',
    description:
      'Возвращает результаты этапов кандидата, кроме удалённых в корзину (архивные включены), по возрастанию даты создания. ' +
      'Если `args` — не UUID, возвращается пустой массив (без ошибки). Доступно любому пользователю.',
    args: uuid('ID кандидата.'),
    example: '00000000-0000-4000-8000-000000000001',
    result: { type: 'array', items: interviewSchema }
  },

  getInterviewContext: {
    tag: 'Интервью и этапы',
    summary: 'Контекст перевода кандидата на этап: шаблоны и обязательность итога',
    description:
      'Проверяет, что переход разрешён, и возвращает данные для формы перевода: карточку кандидата, ' +
      'шаблоны вопросов вакансии для этапа **назначения** и признак обязательности итога. Ничего не меняет.\n\n' +
      '- Кандидат должен быть не в архиве, иначе 404 «Кандидат не найден.».\n' +
      '- Разрешённые переходы: по воронке на соседние этапы и в «Отказано» с любого этапа; из «Отказано» — только на этап, ' +
      'с которого отказали. Иначе 400 «Переход … не разрешён.».\n' +
      '- При переходе в «Отказано» или из него `templates` пуст и `resultRequired` = false.',
    args: {
      type: 'object',
      properties: {
        candidateId: uuid('ID кандидата.'),
        toStatus: { type: 'string', enum: STATUSES, description: 'Этап, на который переводят.' }
      },
      required: ['candidateId', 'toStatus']
    },
    example: { candidateId: '00000000-0000-4000-8000-000000000001', toStatus: 'Проф. интервью' },
    result: {
      type: 'object',
      properties: {
        candidate: candidateSchema,
        fromStatus: { type: 'string', enum: STATUSES, description: 'Текущий этап кандидата.' },
        toStatus: { type: 'string', enum: STATUSES, description: 'Этап назначения.' },
        templates: { type: 'array', items: templateSchema, description: 'Активные шаблоны вакансии для этапа назначения.' },
        resultRequired: { type: 'boolean', description: 'Этап обязательный для вакансии: без итога (result) переход не сохранится.' }
      }
    }
  },

  transitionCandidate: {
    tag: 'Интервью и этапы',
    summary: 'Перевести кандидата на другой этап, в «Отказано» или вернуть из отказа',
    description:
      'Меняет этап кандидата в одной транзакции. Доступно любому пользователю. Три сценария:\n\n' +
      '1. **Обычный переход** (`interview`): создаётся результат этапа с ответственным за этап назначения ' +
      '(HR screening — ответственный HR, Проф. интервью — проф. интервьювер, остальные — рекрутер; ответственный должен быть ' +
      'назначен, активен и иметь доступ к этапу). Если для этапа есть обязательный шаблон — нужно передать его `templateId` и ответы ' +
      'на все вопросы в порядке шаблона (или `skipped: true`). Если этап обязательный для вакансии — нужен `result`. ' +
      '`interview.comment` сохраняется первым комментарием к результату. В журнал изменений пишется создание результата интервью.\n' +
      '2. **Отказ** (`toStatus: "Отказано"`, `rejection`): `byType` — `candidate` или `responsible` (тогда `responsibleId` — ' +
      'один из назначенных кандидату ответственных); `reason` — значение из справочника причин отказа соответствующей категории; ' +
      'для причины «Другое» обязателен `comment`.\n' +
      '3. **Возврат из «Отказано»** — только на этап, с которого отказали; анкета не заполняется, `comment` — комментарий к переходу.\n\n' +
      'Во всех случаях запись добавляется в журнал переходов кандидата, участникам и подписчикам отправляются уведомления ' +
      '(в приложении, email, Telegram — по их настройкам). Ошибки: 400 — переход не разрешён или не пройдена валидация, 404 — кандидат не найден или в архиве.',
    args: {
      type: 'object',
      properties: {
        candidateId: uuid('ID кандидата (не архивного).'),
        toStatus: { type: 'string', enum: STATUSES, description: 'Этап назначения.' },
        interview: {
          type: 'object',
          description: 'Анкета этапа — только для обычного перехода.',
          properties: {
            templateId: { type: 'string', format: 'uuid', description: 'ID шаблона из getInterviewContext.templates; обязателен, если у этапа есть обязательный шаблон.' },
            answers: {
              type: 'array',
              description: 'Ответы в порядке вопросов шаблона. Элементы без question и answer отбрасываются.',
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string', description: 'Текст вопроса (должен совпадать с текстом в шаблоне).' },
                  answer: richText('Ответ.'),
                  skipped: { type: 'boolean', description: 'Вопрос не задавался (учитывается, только если answer пуст).' }
                }
              }
            },
            result: richText('Итог этапа; обязателен, если этап обязательный для вакансии.'),
            comment: richText('Комментарий к переходу — сохраняется первым комментарием к результату.')
          }
        },
        rejection: {
          type: 'object',
          description: 'Данные отказа — только при toStatus = «Отказано».',
          properties: {
            byType: { type: 'string', enum: ['candidate', 'responsible'], description: 'Кем отказано: кандидатом или компанией (ответственным).' },
            responsibleId: { type: 'string', format: 'uuid', description: 'Для byType = responsible: ID рекрутера, HR или проф. интервьювера кандидата.' },
            reason: { type: 'string', description: 'Причина из справочника («Причины отказа: кандидат» / «Причины отказа: компания»).' },
            comment: richText('Пояснение; обязательно для причины «Другое».')
          },
          required: ['byType', 'reason']
        },
        comment: { type: 'string', description: 'Только при возврате из «Отказано»: комментарий к переходу (по умолчанию «Возврат из «Отказано»»).' }
      },
      required: ['candidateId', 'toStatus']
    },
    example: {
      candidateId: '00000000-0000-4000-8000-000000000001',
      toStatus: 'Проф. интервью',
      interview: {
        templateId: '00000000-0000-4000-8000-000000000002',
        answers: [
          { question: 'Почему ищете работу?', answer: '<p>Хочу расти в .NET-разработке.</p>' },
          { question: 'Ожидания по зарплате?', skipped: true }
        ],
        result: '<p>Рекомендую на проф. интервью.</p>',
        comment: 'Созвонились, кандидат мотивирован.'
      }
    },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        candidate: candidateSchema,
        interview: {
          ...interviewSchema,
          type: ['object', 'null'],
          description: 'Созданный результат этапа; null при отказе и возврате из «Отказано».'
        }
      }
    }
  },

  updateInterview: {
    tag: 'Интервью и этапы',
    summary: 'Изменить итог и ответы результата этапа',
    description:
      'Обновляет итог (`result`) и, если передан массив, ответы (`answers`) результата интервью, не удалённого в корзину. ' +
      '`result` перезаписывается всегда (не передан — станет пустым); для обязательного этапа вакансии пустой итог — ошибка 400. ' +
      'Изменённые поля пишутся в журнал изменений, участникам кандидата уходит уведомление об изменении. Доступно любому пользователю. ' +
      '404 — результат не найден.',
    args: {
      type: 'object',
      properties: {
        id: uuid('Interview ID.'),
        result: richText('Новый итог этапа.'),
        answers: {
          type: 'array',
          description: 'Новые ответы; если не массив — ответы не меняются.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              answer: richText('Ответ.'),
              skipped: { type: 'boolean' }
            }
          }
        }
      },
      required: ['id']
    },
    example: {
      id: '00000000-0000-4000-8000-000000000003',
      result: '<p>Сильный кандидат, рекомендую к офферу.</p>'
    },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        interview: interviewSchema
      }
    }
  },

  archiveEntity: {
    tag: 'Жизненный цикл записей',
    summary: 'Отправить запись в архив',
    description:
      'Архивирует запись любого типа. Доступно любому пользователю, для `user` — только администраторам. ' +
      'Уже архивная запись — без изменений (`ok: true`); запись в корзине — ошибка 400. ' +
      'Для пользователя: нельзя архивировать себя и последнего активного администратора; архивный пользователь теряет доступ и права администратора. ' +
      'Событие пишется в журнал изменений; для кандидата и результата интервью — уведомление участникам кандидата. 404 — запись не найдена.',
    args: lifecycleArgs,
    example: { type: 'candidate', id: '00000000-0000-4000-8000-000000000001' },
    result: okSchema
  },

  unarchiveEntity: {
    tag: 'Жизненный цикл записей',
    summary: 'Вернуть запись из архива',
    description:
      'Снимает архивный признак. Доступно любому пользователю, для `user` — только администраторам. ' +
      'Запись в корзине — ошибка 400 (сначала restoreEntity); неархивная — без изменений. ' +
      'Возвращённый пользователь остаётся без доступа (открывается отдельно). Событие пишется в журнал изменений; ' +
      'для кандидата и результата интервью — уведомление участникам кандидата.',
    args: lifecycleArgs,
    example: { type: 'vacancy', id: '00000000-0000-4000-8000-000000000004' },
    result: okSchema
  },

  deleteEntity: {
    tag: 'Жизненный цикл записей',
    summary: 'Удалить архивную запись в корзину (только администраторы)',
    description:
      'Переносит **архивную** запись в корзину; неархивная — ошибка 400. Только администраторы (иначе 403). ' +
      'Вакансию нельзя удалить, пока на неё ссылаются кандидаты; пользователя — пока он назначен ответственным у кандидатов. ' +
      'Через 30 дней запись окончательно удаляется из БД вместе с комментариями и журналом (для кандидата — ещё и файлы резюме, ' +
      'а его папка в Google Drive переносится в корзину Drive). Событие пишется в журнал изменений; для кандидата и результата интервью — уведомление. ' +
      'Уже удалённая запись — `{ ok: true }` без `purgeAfterDays`.',
    args: lifecycleArgs,
    example: { type: 'source', id: '00000000-0000-4000-8000-000000000005' },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        purgeAfterDays: { type: 'integer', description: 'Через сколько дней запись будет удалена окончательно (30). Нет, если запись уже была в корзине.' }
      },
      required: ['ok']
    }
  },

  restoreEntity: {
    tag: 'Жизненный цикл записей',
    summary: 'Восстановить запись из корзины в архив (только администраторы)',
    description:
      'Убирает запись из корзины — она возвращается в архив. Только администраторы (иначе 403). ' +
      'Запись не в корзине — без изменений. Событие пишется в журнал изменений; для кандидата и результата интервью — уведомление.',
    args: lifecycleArgs,
    example: { type: 'interview', id: '00000000-0000-4000-8000-000000000003' },
    result: okSchema
  },

  getHistory: {
    tag: 'Журнал изменений',
    summary: 'Журнал изменений записи',
    description:
      'Возвращает до 500 последних записей журнала изменений сущности (новые сверху). Для кандидата добавляются до 200 переходов по этапам ' +
      'из журнала переходов (action `status` или `create`, field `status`). История пользователей (`user`) — только для администраторов (403). ' +
      'Запись может уже не существовать (удалена окончательно) — тогда `exists: false`. `canRevert` = true у изменений полей, ' +
      'которые можно откатить через revertChange (запись не в корзине и текущее значение отличается от прежнего).',
    args: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: LIFECYCLE_TYPES, description: 'Тип записи.' },
        entityId: uuid('ID записи.')
      },
      required: ['entityType', 'entityId']
    },
    example: { entityType: 'candidate', entityId: '00000000-0000-4000-8000-000000000001' },
    result: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: LIFECYCLE_TYPES },
        entityId: { type: 'string', format: 'uuid' },
        exists: { type: 'boolean', description: 'Запись существует в БД (в т.ч. в архиве или корзине).' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'ID записи журнала (UUID); для переходов кандидата — «status-<UUID>».' },
              action: {
                type: 'string',
                enum: ['create', 'update', 'status', 'archive', 'unarchive', 'delete', 'restore', 'revert'],
                description: 'Тип события.'
              },
              actionLabel: { type: 'string', description: 'Подпись события по-русски («Изменение», «В архив» и т.п.).' },
              field: { type: 'string', description: 'Ключ поля (для событий без поля — пустая строка).' },
              fieldLabel: { type: 'string', description: 'Подпись поля.' },
              oldDisplay: { type: 'string', description: 'Было — текст для людей.' },
              newDisplay: { type: 'string', description: 'Стало — текст для людей.' },
              actorName: { type: 'string', description: 'Кто изменил («Система», если без пользователя).' },
              createdAt: dateTime('Когда.'),
              createdAtIso: { type: 'string', format: 'date-time', description: 'Когда (ISO 8601).' },
              revertedFrom: { type: ['string', 'null'], format: 'uuid', description: 'Для action = revert — ID откатываемой записи журнала.' },
              comment: { type: 'string', description: 'Комментарий к переходу (только у переходов кандидата).' },
              canRevert: { type: 'boolean', description: 'Изменение можно откатить через revertChange.' }
            }
          }
        }
      }
    }
  },

  revertChange: {
    tag: 'Журнал изменений',
    summary: 'Вернуть прежнее значение поля по записи журнала',
    description:
      'Восстанавливает значение поля «было» из записи журнала с action `update` или `revert`. Откат сам записывается в журнал ' +
      '(action `revert`, `revertedFrom`). Для кандидата участникам уходит уведомление об изменении карточки. ' +
      'Откат полей пользователя — только администраторам (403). Ошибки 400: изменение нельзя вернуть, запись в корзине, ' +
      'поле уже содержит это значение, прежнее значение ссылки (вакансия/источник/пользователь) удалено, снятие прав с себя или с последнего администратора. ' +
      '404 — запись журнала или сущность не найдена.',
    args: {
      type: 'object',
      properties: { id: uuid('ID записи журнала (entries[].id из getHistory с canRevert = true).') },
      required: ['id']
    },
    example: { id: '00000000-0000-4000-8000-000000000006' },
    result: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        entityType: { type: 'string', enum: LIFECYCLE_TYPES, description: 'Тип изменённой записи.' },
        entityId: uuid('ID изменённой записи.')
      }
    }
  },

  listComments: {
    tag: 'Комментарии',
    summary: 'Комментарии к записи',
    description:
      'Все комментарии к кандидату, вакансии или результату интервью по возрастанию даты — плоским списком ' +
      '(ответы связаны через `parentId`, один уровень вложенности). Флаги `canEdit`, `canDelete`, `reactions[].mine` ' +
      'вычисляются для текущего пользователя. 404 — запись не найдена; 400 — тип не поддерживает комментарии.',
    args: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: COMMENT_ENTITY_TYPES, description: 'Тип записи.' },
        entityId: uuid('ID записи.')
      },
      required: ['entityType', 'entityId']
    },
    example: { entityType: 'candidate', entityId: '00000000-0000-4000-8000-000000000001' },
    result: { type: 'array', items: commentSchema }
  },

  addComment: {
    tag: 'Комментарии',
    summary: 'Добавить комментарий или ответ',
    description:
      'Создаёт комментарий от имени текущего пользователя. Запись в корзине комментировать нельзя (400). ' +
      'Ответ на ответ прикрепляется к исходному комментарию верхнего уровня; `parentId` должен относиться к той же записи (иначе 404). ' +
      'Пустой текст — 400 «Комментарий пустой.». Комментарий к кандидату или его результату интервью — уведомление участникам и подписчикам кандидата.',
    args: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: COMMENT_ENTITY_TYPES, description: 'Тип записи.' },
        entityId: uuid('ID записи.'),
        bodyHtml: richText('Текст комментария.'),
        parentId: { type: 'string', format: 'uuid', description: 'ID комментария, на который отвечают.' }
      },
      required: ['entityType', 'entityId', 'bodyHtml']
    },
    example: {
      entityType: 'candidate',
      entityId: '00000000-0000-4000-8000-000000000001',
      bodyHtml: '<p>Договорились о звонке на пятницу.</p>'
    },
    result: commentSchema
  },

  updateComment: {
    tag: 'Комментарии',
    summary: 'Изменить свой комментарий',
    description:
      'Заменяет текст комментария и отмечает его как отредактированный. Только автор (иначе 403). ' +
      'Пустой текст — 400, комментарий не найден — 404. В журнал изменений и уведомления не пишется.',
    args: {
      type: 'object',
      properties: {
        id: uuid('ID комментария.'),
        bodyHtml: richText('Новый текст.')
      },
      required: ['id', 'bodyHtml']
    },
    example: { id: '00000000-0000-4000-8000-000000000007', bodyHtml: '<p>Звонок перенесли на понедельник.</p>' },
    result: commentSchema
  },

  deleteComment: {
    tag: 'Комментарии',
    summary: 'Удалить комментарий вместе с ответами',
    description:
      'Окончательно удаляет комментарий и все ответы на него (без корзины). Автор или администратор (иначе 403). 404 — не найден.',
    args: uuid('ID комментария.'),
    example: '00000000-0000-4000-8000-000000000007',
    result: okSchema
  },

  toggleReaction: {
    tag: 'Комментарии',
    summary: 'Поставить или снять реакцию на комментарий',
    description:
      'Если у текущего пользователя уже есть эта реакция на комментарий — снимает её, иначе ставит. ' +
      'Неподдерживаемый эмодзи — 400, комментарий не найден — 404.',
    args: {
      type: 'object',
      properties: {
        commentId: uuid('ID комментария.'),
        emoji: { type: 'string', enum: REACTIONS, description: 'Реакция.' }
      },
      required: ['commentId', 'emoji']
    },
    example: { commentId: '00000000-0000-4000-8000-000000000007', emoji: '👍' },
    result: {
      type: 'object',
      properties: { reactions: reactionsSchema }
    }
  }
};
