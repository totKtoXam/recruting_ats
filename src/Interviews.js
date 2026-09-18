function getInterviews(candidateId) {
  if (!candidateId) {
    return [];
  }

  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.INTERVIEWS
    )
  )
    .filter(interview =>
      String(
        interview['Candidate ID']
      ) ===
      String(candidateId)
    )
    .map(interview => ({
      ...interview,
      answers: parseJson_(
        interview['Вопросы и ответы'],
        []
      )
    }));
}


function getInterviewContext(input) {
  const candidateId = input && input.candidateId;
  const toStatus = input && input.toStatus;
  const candidate = findById_(
    APP_CONFIG.SHEETS.CANDIDATES,
    'ID',
    candidateId
  );

  if (!candidate) {
    throw new Error(
      'Кандидат не найден.'
    );
  }

  const allowed =
    APP_CONFIG.TRANSITIONS[
      candidate['Статус']
    ] || [];

  if (
    !allowed.includes(toStatus)
  ) {
    throw new Error(
      'Переход "' +
      candidate['Статус'] +
      '" → "' +
      toStatus +
      '" не разрешён.'
    );
  }

  const templates =
    getInterviewTemplates()
      .filter(template =>
        String(
          template['Vacancy ID']
        ) ===
        String(
          candidate['Vacancy ID']
        ) &&
        template['Этап'] ===
          candidate['Статус']
      );

  return {
    candidate,
    fromStatus:
      candidate['Статус'],
    toStatus,
    templates
  };
}


function transitionCandidate(input) {
  if (
    !input ||
    !input.candidateId ||
    !input.toStatus
  ) {
    throw new Error(
      'Не указаны параметры перехода.'
    );
  }

  const sheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  const found = findRowById_(
    sheet,
    'ID',
    input.candidateId
  );

  if (found.rowIndex < 0) {
    throw new Error(
      'Кандидат не найден.'
    );
  }

  const candidate = objectFromRow_(
    found.headers,
    found.values
  );

  const fromStatus =
    candidate['Статус'];

  const allowed =
    APP_CONFIG.TRANSITIONS[
      fromStatus
    ] || [];

  if (
    !allowed.includes(
      input.toStatus
    )
  ) {
    throw new Error(
      'Переход "' +
      fromStatus +
      '" → "' +
      input.toStatus +
      '" не разрешён.'
    );
  }

  const interview = saveTransitionInterview_(
    candidate,
    fromStatus,
    input.toStatus,
    input.interview || {}
  );

  candidate['Статус'] =
    input.toStatus;

  candidate['Дата изменения'] =
    formatNow_();

  const responsible = resolveResponsibleForStage_(
    input.responsibleId,
    candidate['Responsible ID'],
    input.toStatus
  );

  candidate['Responsible ID'] =
    responsible['Responsible ID'];

  candidate['Ответственный'] =
    responsible['ФИО'];

  const row = found.headers.map(
    header =>
      candidate[header] !== undefined
        ? candidate[header]
        : ''
  );

  sheet
    .getRange(
      found.rowIndex,
      1,
      1,
      found.headers.length
    )
    .setValues([row]);

  return {
    ok: true,
    candidate,
    interview
  };
}


function resolveResponsibleForStage_(
  requestedId,
  currentId,
  stage
) {
  const id =
    requestedId ||
    currentId;

  const responsible = findById_(
    APP_CONFIG.SHEETS.RESPONSIBLES,
    'Responsible ID',
    id
  );

  if (!responsible) {
    throw new Error(
      'Выберите ответственного для этапа "' +
      stage +
      '".'
    );
  }

  const stages = parseJson_(
    responsible['Доступные этапы'],
    []
  );

  if (!stages.includes(stage)) {
    throw new Error(
      'Ответственный "' +
      responsible['ФИО'] +
      '" недоступен для этапа "' +
      stage +
      '".'
    );
  }

  return responsible;
}


function saveTransitionInterview_(
  candidate,
  fromStatus,
  toStatus,
  input
) {
  const templateId = String(
    input.templateId || ''
  );

  let template = null;

  if (templateId) {
    template = findById_(
      APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
      'Template ID',
      templateId
    );

    if (!template) {
      throw new Error(
        'Шаблон интервью не найден.'
      );
    }

    if (
      String(
        template['Vacancy ID']
      ) !==
        String(
          candidate['Vacancy ID']
        ) ||
      template['Этап'] !==
        fromStatus
    ) {
      throw new Error(
        'Шаблон интервью не соответствует вакансии и этапу.'
      );
    }
  }

  const answers = Array.isArray(
    input.answers
  )
    ? input.answers
        .map(item => ({
          question:
            String(
              item.question || ''
            ).trim(),
          answer:
            String(
              item.answer || ''
            ).trim()
        }))
        .filter(item =>
          item.question ||
          item.answer
        )
    : [];

  const comment = String(
    input.comment || ''
  ).trim();

  const result = String(
    input.result || ''
  ).trim();

  if (
    !result
  ) {
    throw new Error(
      'Укажите результат интервью/этапа.'
    );
  }

  const responsible = findById_(
    APP_CONFIG.SHEETS.RESPONSIBLES,
    'Responsible ID',
    candidate['Responsible ID']
  );

  const now = formatNow_();

  const interview = {
    'Interview ID':
      Utilities.getUuid(),
    'Candidate ID':
      candidate.ID,
    'ФИО':
      candidate['ФИО'],
    'Vacancy ID':
      candidate['Vacancy ID'],
    'Вакансия':
      candidate['Вакансия'],
    'Этап':
      fromStatus,
    'From Status':
      fromStatus,
    'To Status':
      toStatus,
    'Template ID':
      template
        ? template['Template ID']
        : '',
    'Шаблон':
      template
        ? template['Название']
        : '',
    'Дата': now,
    'Интервьюер':
      responsible
        ? responsible['ФИО']
        : candidate['Ответственный'],
    'Responsible ID':
      candidate['Responsible ID'],
    'Вопросы и ответы':
      stringifyJson_(answers),
    'Комментарий':
      comment,
    'Результат':
      result,
    'Дата изменения':
      now
  };

  upsertObject_(
    APP_CONFIG.SHEETS.INTERVIEWS,
    'Interview ID',
    interview
  );

  return {
    ...interview,
    answers
  };
}


function updateInterview(input) {
  if (
    !input ||
    !input.id
  ) {
    throw new Error(
      'Не указан Interview ID.'
    );
  }

  const existing = findById_(
    APP_CONFIG.SHEETS.INTERVIEWS,
    'Interview ID',
    input.id
  );

  if (!existing) {
    throw new Error(
      'Результат интервью не найден.'
    );
  }

  const answers = Array.isArray(
    input.answers
  )
    ? input.answers
    : parseJson_(
        existing['Вопросы и ответы'],
        []
      );

  const entity = upsertObject_(
    APP_CONFIG.SHEETS.INTERVIEWS,
    'Interview ID',
    {
      ...existing,
      'Вопросы и ответы':
        stringifyJson_(answers),
      'Комментарий':
        String(
          input.comment || ''
        ).trim(),
      'Результат':
        String(
          input.result || ''
        ).trim(),
      'Дата изменения':
        formatNow_()
    }
  );

  return {
    ok: true,
    interview: {
      ...entity,
      answers
    }
  };
}
