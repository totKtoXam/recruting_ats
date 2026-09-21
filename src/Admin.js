function getVacancies() {
  return rowsToObjects_(
    getSheet_(APP_CONFIG.SHEETS.VACANCIES)
  ).filter(item => !isSoftDeleted_(item));
}


function saveVacancy(input) {
  const name = String(input && input.name || '').trim();
  const status = String(input && input.status || '').trim();

  if (!name) {
    throw new Error('Название вакансии обязательно.');
  }

  if (!APP_CONFIG.VACANCY_STATUSES.includes(status)) {
    throw new Error('Некорректный статус вакансии.');
  }

  const existing = input.id
    ? findById_(
        APP_CONFIG.SHEETS.VACANCIES,
        'Vacancy ID',
        input.id
      )
    : null;

  if (required) {
    const duplicateRequired =
      getInterviewTemplates()
        .find(template =>
          String(
            template['Vacancy ID']
          ) === vacancyId &&
          template['Этап'] === stage &&
          template.required &&
          String(
            template['Template ID']
          ) !== String(
            input.id || ''
          )
        );

    if (duplicateRequired) {
      throw new Error(
        'Для этой вакансии и этапа уже есть обязательный шаблон.'
      );
    }
  }

  const now = formatNow_();

  const entity = upsertObject_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    {
      ...existing,
      'Vacancy ID': input.id || Utilities.getUuid(),
      '№':
        existing && existing['№']
          ? existing['№']
          : getNextNumber_(
              APP_CONFIG.SHEETS.VACANCIES,
              '№'
            ),
      'Вакансия': name,
      'Статус': status,
      'Комментарий': String(input.comment || '').trim(),
      'Дата создания':
        existing && existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now,
      'Удален': false,
      'Дата удаления': ''
    }
  );

  return { ok: true, vacancy: entity };
}


function deleteVacancy(id) {
  const result = softDeleteById_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    id
  );

  rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES
    )
  )
    .filter(template =>
      !isSoftDeleted_(template) &&
      String(template['Vacancy ID']) === String(id)
    )
    .forEach(template =>
      softDeleteById_(
        APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
        'Template ID',
        template['Template ID']
      )
    );

  return result;
}


function getSources() {
  return rowsToObjects_(
    getSheet_(APP_CONFIG.SHEETS.SOURCES)
  ).filter(item => !isSoftDeleted_(item));
}


function saveSource(input) {
  const name = String(input && input.name || '').trim();

  if (!name) {
    throw new Error('Название источника обязательно.');
  }

  const duplicate = getSources().some(source =>
    source['Название'].toLowerCase() === name.toLowerCase() &&
    String(source['Source ID']) !== String(input.id || '')
  );

  if (duplicate) {
    throw new Error('Источник с таким названием уже существует.');
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
      ...existing,
      'Source ID': input.id || Utilities.getUuid(),
      '№':
        existing && existing['№']
          ? existing['№']
          : getNextNumber_(
              APP_CONFIG.SHEETS.SOURCES,
              '№'
            ),
      'Название': name,
      'Дата создания':
        existing && existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now,
      'Удален': false,
      'Дата удаления': ''
    }
  );

  return { ok: true, source: entity };
}


function deleteSource(id) {
  return softDeleteById_(
    APP_CONFIG.SHEETS.SOURCES,
    'Source ID',
    id
  );
}


function getResponsibles() {
  return rowsToObjects_(
    getSheet_(APP_CONFIG.SHEETS.RESPONSIBLES)
  )
    .filter(item => !isSoftDeleted_(item))
    .map(item => {
      const fallback = splitFullName_(item['ФИО']);

      return {
        ...item,
        'Фамилия': item['Фамилия'] || fallback.lastName,
        'Имя': item['Имя'] || fallback.firstName,
        'Отчество': item['Отчество'] || fallback.middleName,
        stages: parseJson_(item['Доступные этапы'], [])
      };
    });
}


function saveResponsible(input) {
  const lastName = normalizeNamePart_(input && input.lastName);
  const firstName = normalizeNamePart_(input && input.firstName);
  const middleName = normalizeNamePart_(input && input.middleName);
  const fullName = composeFullName_(
    lastName,
    firstName,
    middleName
  );

  const email = validateEmail_(input && input.email);

  const userId = String(
    input &&
    input.userId !== undefined
      ? input.userId || ''
      : ''
  ).trim();

  if (userId) {
    const user = findById_(
      APP_CONFIG.SHEETS.USERS,
      'User ID',
      userId
    );

    if (!user) {
      throw new Error(
        'Выбранный пользователь не найден.'
      );
    }

    const linked = rowsToObjects_(
      getSheet_(
        APP_CONFIG.SHEETS.RESPONSIBLES
      )
    ).find(item =>
      !isSoftDeleted_(item) &&
      String(item['User ID'] || '') === userId &&
      String(item['Responsible ID'] || '') !==
        String(input && input.id || '')
    );

    if (linked) {
      throw new Error(
        'Этот пользователь уже привязан к ответственному "' +
        linked['ФИО'] +
        '".'
      );
    }
  }

  const stages = Array.isArray(input && input.stages)
    ? input.stages
    : [];

  if (!lastName || !firstName) {
    throw new Error('Фамилия и имя ответственного обязательны.');
  }

  if (!stages.length) {
    throw new Error('Выберите хотя бы один доступный этап.');
  }

  const invalid = stages.filter(stage =>
    !APP_CONFIG.PIPELINE_STATUSES.includes(stage)
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
      ...existing,
      'Responsible ID': input.id || Utilities.getUuid(),
      '№':
        existing && existing['№']
          ? existing['№']
          : getNextNumber_(
              APP_CONFIG.SHEETS.RESPONSIBLES,
              '№'
            ),
      'Фамилия': lastName,
      'Имя': firstName,
      'Отчество': middleName,
      'ФИО': fullName,
      'Email': email,
      'User ID': userId,
      'Доступные этапы': stringifyJson_(stages),
      'Дата создания':
        existing && existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now,
      'Удален': false,
      'Дата удаления': ''
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
  return softDeleteById_(
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
  )
    .filter(item => !isSoftDeleted_(item))
    .map(item => ({
      ...item,
      required:
        String(
          item['Обязательный'] || ''
        ).toLowerCase() === 'true',
      questions: parseJson_(item['Вопросы'], [])
    }));
}


function saveInterviewTemplate(input) {
  const name = String(input && input.name || '').trim();
  const vacancyId = String(input && input.vacancyId || '').trim();
  const stage = String(input && input.stage || '').trim();
  const required =
    input &&
    (
      input.required === true ||
      String(
        input.required || ''
      ).toLowerCase() === 'true'
    );

  const questions = Array.isArray(input && input.questions)
    ? input.questions
        .map(question => String(question || '').trim())
        .filter(Boolean)
    : [];

  if (!name) {
    throw new Error('Название шаблона обязательно.');
  }

  if (!vacancyId) {
    throw new Error('Вакансия обязательна.');
  }

  if (!APP_CONFIG.PIPELINE_STATUSES.includes(stage)) {
    throw new Error('Выберите корректный этап.');
  }

  if (!questions.length) {
    throw new Error('Добавьте хотя бы один вопрос.');
  }

  const vacancy = findById_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    vacancyId
  );

  if (!vacancy || isSoftDeleted_(vacancy)) {
    throw new Error('Вакансия не найдена.');
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
      ...existing,
      'Template ID': input.id || Utilities.getUuid(),
      '№':
        existing && existing['№']
          ? existing['№']
          : getNextNumber_(
              APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
              '№'
            ),
      'Название': name,
      'Vacancy ID': vacancyId,
      'Вакансия': vacancy['Вакансия'],
      'Этап': stage,
      'Обязательный': required,
      'Вопросы': stringifyJson_(questions),
      'Дата создания':
        existing && existing['Дата создания']
          ? existing['Дата создания']
          : now,
      'Дата изменения': now,
      'Удален': false,
      'Дата удаления': ''
    }
  );

  return {
    ok: true,
    template: {
      ...entity,
      required,
      questions
    }
  };
}


function deleteInterviewTemplate(id) {
  return softDeleteById_(
    APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
    'Template ID',
    id
  );
}


function getDictionaries() {
  const sheet = getSheet_(APP_CONFIG.SHEETS.DICTS);
  const values = sheet.getDataRange().getDisplayValues();

  if (!values.length) {
    return {};
  }

  const headers = values[0];
  const result = {};

  headers.forEach((header, columnIndex) => {
    if (!header) {
      return;
    }

    result[header] = values
      .slice(1)
      .map(row => row[columnIndex])
      .filter(Boolean);
  });

  return result;
}
