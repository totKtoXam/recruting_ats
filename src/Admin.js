function getVacancies() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.VACANCIES
    )
  );
}


function saveVacancy(input) {
  const name = String(
    input && input.name || ''
  ).trim();

  const status = String(
    input && input.status || ''
  ).trim();

  if (!name) {
    throw new Error(
      'Название вакансии обязательно.'
    );
  }

  if (
    !APP_CONFIG.VACANCY_STATUSES.includes(status)
  ) {
    throw new Error(
      'Некорректный статус вакансии.'
    );
  }

  const existing = input.id
    ? findById_(
        APP_CONFIG.SHEETS.VACANCIES,
        'Vacancy ID',
        input.id
      )
    : null;

  const now = formatNow_();

  const entity = upsertObject_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    {
      'Vacancy ID':
        input.id ||
        Utilities.getUuid(),
      'Вакансия': name,
      'Статус': status,
      'Комментарий':
        String(input.comment || '').trim(),
      'Дата создания':
        existing &&
        existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now
    }
  );

  return {
    ok: true,
    vacancy: entity
  };
}


function deleteVacancy(id) {
  const candidates = getCandidates();

  if (
    candidates.some(candidate =>
      String(candidate['Vacancy ID']) ===
      String(id)
    )
  ) {
    throw new Error(
      'Нельзя удалить вакансию: к ней привязаны кандидаты. Переведите вакансию в статус "Закрыта".'
    );
  }

  const templates = getInterviewTemplates();

  if (
    templates.some(template =>
      String(template['Vacancy ID']) ===
      String(id)
    )
  ) {
    throw new Error(
      'Нельзя удалить вакансию: к ней привязаны шаблоны интервью.'
    );
  }

  return deleteRowById_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    id
  );
}


function getSources() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.SOURCES
    )
  );
}


function saveSource(input) {
  const name = String(
    input && input.name || ''
  ).trim();

  if (!name) {
    throw new Error(
      'Название источника обязательно.'
    );
  }

  const duplicate = getSources()
    .some(source =>
      source['Название']
        .toLowerCase() ===
        name.toLowerCase() &&
      String(source['Source ID']) !==
        String(input.id || '')
    );

  if (duplicate) {
    throw new Error(
      'Источник с таким названием уже существует.'
    );
  }

  const existing = input.id
    ? findById_(
        APP_CONFIG.SHEETS.SOURCES,
        'Source ID',
        input.id
      )
    : null;

  const now = formatNow_();

  const entity = upsertObject_(
    APP_CONFIG.SHEETS.SOURCES,
    'Source ID',
    {
      'Source ID':
        input.id ||
        Utilities.getUuid(),
      'Название': name,
      'Дата создания':
        existing &&
        existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now
    }
  );

  return {
    ok: true,
    source: entity
  };
}


function deleteSource(id) {
  const candidates = getCandidates();

  if (
    candidates.some(candidate =>
      String(candidate['Source ID']) ===
      String(id)
    )
  ) {
    throw new Error(
      'Нельзя удалить источник: он используется кандидатами.'
    );
  }

  return deleteRowById_(
    APP_CONFIG.SHEETS.SOURCES,
    'Source ID',
    id
  );
}


function getResponsibles() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.RESPONSIBLES
    )
  ).map(item => ({
    ...item,
    stages: parseJson_(
      item['Доступные этапы'],
      []
    )
  }));
}


function saveResponsible(input) {
  const name = String(
    input && input.name || ''
  ).trim();

  const email = validateEmail_(
    input && input.email
  );

  const stages = Array.isArray(
    input && input.stages
  )
    ? input.stages
    : [];

  if (!name) {
    throw new Error(
      'ФИО ответственного обязательно.'
    );
  }

  if (!stages.length) {
    throw new Error(
      'Выберите хотя бы один доступный этап.'
    );
  }

  const invalid = stages.filter(
    stage =>
      !APP_CONFIG.PIPELINE_STATUSES.includes(
        stage
      )
  );

  if (invalid.length) {
    throw new Error(
      'Некорректные этапы ответственного: ' +
      invalid.join(', ')
    );
  }

  const existing = input.id
    ? findById_(
        APP_CONFIG.SHEETS.RESPONSIBLES,
        'Responsible ID',
        input.id
      )
    : null;

  const now = formatNow_();

  const entity = upsertObject_(
    APP_CONFIG.SHEETS.RESPONSIBLES,
    'Responsible ID',
    {
      'Responsible ID':
        input.id ||
        Utilities.getUuid(),
      'ФИО': name,
      'Email': email,
      'Доступные этапы':
        stringifyJson_(stages),
      'Дата создания':
        existing &&
        existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now
    }
  );

  return {
    ok: true,
    responsible: {
      ...entity,
      stages
    }
  };
}


function deleteResponsible(id) {
  const candidates = getCandidates();

  if (
    candidates.some(candidate =>
      String(candidate['Responsible ID']) ===
      String(id)
    )
  ) {
    throw new Error(
      'Нельзя удалить ответственного: он назначен кандидатам.'
    );
  }

  return deleteRowById_(
    APP_CONFIG.SHEETS.RESPONSIBLES,
    'Responsible ID',
    id
  );
}


function getInterviewTemplates() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES
    )
  ).map(item => ({
    ...item,
    questions: parseJson_(
      item['Вопросы'],
      []
    )
  }));
}


function saveInterviewTemplate(input) {
  const name = String(
    input && input.name || ''
  ).trim();

  const vacancyId = String(
    input && input.vacancyId || ''
  ).trim();

  const stage = String(
    input && input.stage || ''
  ).trim();

  const questions = Array.isArray(
    input && input.questions
  )
    ? input.questions
        .map(question =>
          String(question || '').trim()
        )
        .filter(Boolean)
    : [];

  if (!name) {
    throw new Error(
      'Название шаблона обязательно.'
    );
  }

  if (!vacancyId) {
    throw new Error(
      'Вакансия обязательна.'
    );
  }

  if (
    !APP_CONFIG.PIPELINE_STATUSES.includes(
      stage
    )
  ) {
    throw new Error(
      'Выберите корректный этап.'
    );
  }

  const vacancy = findById_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    vacancyId
  );

  if (!vacancy) {
    throw new Error(
      'Вакансия не найдена.'
    );
  }

  const existing = input.id
    ? findById_(
        APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
        'Template ID',
        input.id
      )
    : null;

  const now = formatNow_();

  const entity = upsertObject_(
    APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
    'Template ID',
    {
      'Template ID':
        input.id ||
        Utilities.getUuid(),
      'Название': name,
      'Vacancy ID': vacancyId,
      'Вакансия': vacancy['Вакансия'],
      'Этап': stage,
      'Вопросы':
        stringifyJson_(questions),
      'Дата создания':
        existing &&
        existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now
    }
  );

  return {
    ok: true,
    template: {
      ...entity,
      questions
    }
  };
}


function deleteInterviewTemplate(id) {
  return deleteRowById_(
    APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
    'Template ID',
    id
  );
}


function getDictionaries() {
  const sheet = getSheet_(
    APP_CONFIG.SHEETS.DICTS
  );

  const values = sheet
    .getDataRange()
    .getDisplayValues();

  if (!values.length) {
    return {};
  }

  const headers = values[0];
  const result = {};

  headers.forEach(
    (header, columnIndex) => {
      if (!header) {
        return;
      }

      result[header] = values
        .slice(1)
        .map(row =>
          row[columnIndex]
        )
        .filter(Boolean);
    }
  );

  return result;
}
