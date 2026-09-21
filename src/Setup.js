function setupApplication() {
  ensureSchema_();
  ensureSpreadsheetMenuTrigger_();

  return {
    ok: true,
    sheets: Object.values(APP_CONFIG.SHEETS)
  };
}


function ensureSchema_() {
  const ss = getSpreadsheet_();

  const schemas = {};

  schemas[APP_CONFIG.SHEETS.CANDIDATES] = [
    'ID',
    '№',
    'Фамилия',
    'Имя',
    'Отчество',
    'ФИО',
    'Vacancy ID',
    'Вакансия',
    'Статус',
    'Телефон',
    'Email',
    'Telegram',
    'Telegram URL',
    'LinkedIn',
    'GitHub',
    'Source ID',
    'Источник',
    'Зарплатные ожидания',
    'Responsible ID',
    'Ответственный',
    'Резюме',
    'Resume File ID',
    'Версии резюме',
    'Папка кандидата',
    'Комментарий',
    'Иные ссылки',
    'Дата добавления',
    'Дата изменения',
    'Архивирован',
    'Дата архивации',
    'Причина отказа'
  ];

  schemas[APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES] = [
    ...schemas[APP_CONFIG.SHEETS.CANDIDATES]
  ];

  schemas[APP_CONFIG.SHEETS.INTERVIEWS] = [
    'Interview ID',
    'Candidate ID',
    'Фамилия кандидата',
    'Имя кандидата',
    'Отчество кандидата',
    'ФИО',
    'Vacancy ID',
    'Вакансия',
    'Этап',
    'From Status',
    'To Status',
    'Template ID',
    'Шаблон',
    'Дата',
    'Фамилия интервьюера',
    'Имя интервьюера',
    'Отчество интервьюера',
    'Интервьюер',
    'Responsible ID',
    'Вопросы и ответы',
    'Комментарий',
    'Результат',
    'Дата изменения',
    'Удален',
    'Дата удаления'
  ];

  schemas[APP_CONFIG.SHEETS.VACANCIES] = [
    'Vacancy ID',
    '№',
    'Вакансия',
    'Статус',
    'Комментарий',
    'Дата создания',
    'Дата изменения',
    'Удален',
    'Дата удаления'
  ];

  schemas[APP_CONFIG.SHEETS.SOURCES] = [
    'Source ID',
    '№',
    'Название',
    'Дата создания',
    'Дата изменения',
    'Удален',
    'Дата удаления'
  ];

  schemas[APP_CONFIG.SHEETS.RESPONSIBLES] = [
    'Responsible ID',
    '№',
    'Фамилия',
    'Имя',
    'Отчество',
    'ФИО',
    'Email',
    'User ID',
    'Доступные этапы',
    'Дата создания',
    'Дата изменения',
    'Удален',
    'Дата удаления'
  ];

  schemas[APP_CONFIG.SHEETS.USERS] = [
    'User ID',
    'Google Subject',
    'Email',
    'ФИО',
    'Avatar URL',
    'IsActive',
    'Дата создания',
    'Последний вход'
  ];

  schemas[
    APP_CONFIG.SHEETS.CANDIDATE_TRANSITION_STATUS_LOG
  ] = [
    'Transition ID',
    'Candidate ID',
    '№ кандидата',
    'ФИО',
    'From Status',
    'To Status',
    'Responsible ID',
    'Ответственный',
    'Changed By User ID',
    'Changed By',
    'Changed By Email',
    'Комментарий',
    'Дата'
  ];

  schemas[APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES] = [
    'Template ID',
    '№',
    'Название',
    'Vacancy ID',
    'Вакансия',
    'Этап',
    'Вопросы',
    'Дата создания',
    'Дата изменения',
    'Удален',
    'Дата удаления'
  ];

  schemas[APP_CONFIG.SHEETS.CANDIDATE_DRAFTS] = [
    'Draft ID',
    'Token',
    'Данные',
    'Resume File ID',
    'Resume File Name',
    'Resume File URL',
    'Дата создания',
    'Срок действия',
    'Использован',
    'Дата использования',
    'Candidate ID'
  ];

  schemas[APP_CONFIG.SHEETS.DICTS] = [
    'Статусы кандидата',
    'Статусы вакансии'
  ];

  Object.keys(schemas).forEach(sheetName => {
    const sheet =
      ss.getSheetByName(sheetName) ||
      ss.insertSheet(sheetName);

    ensureHeaders_(
      sheet,
      schemas[sheetName]
    );
  });

  seedDictionaries_();
  migrateSourcesFromLegacyDictionary_();
  migrateFullNameColumns_();
  migrateInterviewNameColumns_();
  migrateSequenceNumbers_();
  migrateResumeVersions_();
  migrateArchivedCandidates_();
}


function ensureHeaders_(sheet, requiredHeaders) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn === 0) {
    sheet
      .getRange(
        1,
        1,
        1,
        requiredHeaders.length
      )
      .setValues([requiredHeaders]);

    sheet.setFrozenRows(1);
    return;
  }

  const currentHeaders = sheet
    .getRange(
      1,
      1,
      1,
      lastColumn
    )
    .getValues()[0]
    .map(String);

  const missing = requiredHeaders.filter(
    header =>
      !currentHeaders.includes(header)
  );

  if (!missing.length) {
    return;
  }

  sheet
    .getRange(
      1,
      lastColumn + 1,
      1,
      missing.length
    )
    .setValues([missing]);

  sheet.setFrozenRows(1);
}


function seedDictionaries_() {
  const sheet = getSheet_(
    APP_CONFIG.SHEETS.DICTS
  );

  const headers = getHeaders_(sheet);

  seedDictionaryColumn_(
    sheet,
    headers,
    'Статусы кандидата',
    APP_CONFIG.DEFAULT_STATUSES
  );

  seedDictionaryColumn_(
    sheet,
    headers,
    'Статусы вакансии',
    APP_CONFIG.VACANCY_STATUSES
  );
}


function seedDictionaryColumn_(
  sheet,
  headers,
  headerName,
  values
) {
  const columnIndex =
    headers.indexOf(headerName);

  if (columnIndex < 0) {
    return;
  }

  const lastRow = Math.max(
    sheet.getLastRow(),
    2
  );

  const existing = sheet
    .getRange(
      2,
      columnIndex + 1,
      lastRow - 1,
      1
    )
    .getDisplayValues()
    .flat()
    .filter(Boolean);

  if (existing.length) {
    return;
  }

  sheet
    .getRange(
      2,
      columnIndex + 1,
      values.length,
      1
    )
    .setValues(
      values.map(value => [value])
    );
}


function migrateSourcesFromLegacyDictionary_() {
  const sourceSheet = getSheet_(
    APP_CONFIG.SHEETS.SOURCES
  );

  if (sourceSheet.getLastRow() > 1) {
    return;
  }

  const dictSheet = getSheet_(
    APP_CONFIG.SHEETS.DICTS
  );

  const headers = getHeaders_(dictSheet);
  const legacyIndex =
    headers.indexOf('Источники');

  if (legacyIndex < 0) {
    return;
  }

  const lastRow = dictSheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  const values = dictSheet
    .getRange(
      2,
      legacyIndex + 1,
      lastRow - 1,
      1
    )
    .getDisplayValues()
    .flat()
    .filter(Boolean);

  values.forEach(name => {
    saveSource({
      name
    });
  });
}


function migrateFullNameColumns_() {
  migrateFullNameSheet_(
    APP_CONFIG.SHEETS.CANDIDATES,
    'ФИО'
  );

  migrateFullNameSheet_(
    APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES,
    'ФИО'
  );

  migrateFullNameSheet_(
    APP_CONFIG.SHEETS.RESPONSIBLES,
    'ФИО'
  );
}


function migrateFullNameSheet_(sheetName, fullNameHeader) {
  const sheet = getSheet_(sheetName);
  const headers = getHeaders_(sheet);

  const indexes = {
    full: headers.indexOf(fullNameHeader),
    last: headers.indexOf('Фамилия'),
    first: headers.indexOf('Имя'),
    middle: headers.indexOf('Отчество')
  };

  if (
    indexes.full < 0 ||
    indexes.last < 0 ||
    indexes.first < 0 ||
    indexes.middle < 0 ||
    sheet.getLastRow() < 2
  ) {
    return;
  }

  const range = sheet.getRange(
    2,
    1,
    sheet.getLastRow() - 1,
    headers.length
  );

  const values = range.getValues();
  let changed = false;

  values.forEach(row => {
    if (
      row[indexes.full] &&
      !row[indexes.last] &&
      !row[indexes.first]
    ) {
      const parts = splitFullName_(
        row[indexes.full]
      );

      row[indexes.last] = parts.lastName;
      row[indexes.first] = parts.firstName;
      row[indexes.middle] = parts.middleName;
      changed = true;
    }
  });

  if (changed) {
    range.setValues(values);
  }
}


function migrateInterviewNameColumns_() {
  const sheet = getSheet_(APP_CONFIG.SHEETS.INTERVIEWS);

  if (sheet.getLastRow() < 2) {
    return;
  }

  const headers = getHeaders_(sheet);
  const indexes = {
    candidateFull: headers.indexOf('ФИО'),
    candidateLast: headers.indexOf('Фамилия кандидата'),
    candidateFirst: headers.indexOf('Имя кандидата'),
    candidateMiddle: headers.indexOf('Отчество кандидата'),
    interviewerFull: headers.indexOf('Интервьюер'),
    interviewerLast: headers.indexOf('Фамилия интервьюера'),
    interviewerFirst: headers.indexOf('Имя интервьюера'),
    interviewerMiddle: headers.indexOf('Отчество интервьюера')
  };

  const required = Object.values(indexes);

  if (required.some(index => index < 0)) {
    return;
  }

  const range = sheet.getRange(
    2,
    1,
    sheet.getLastRow() - 1,
    headers.length
  );

  const values = range.getValues();
  let changed = false;

  values.forEach(row => {
    if (
      row[indexes.candidateFull] &&
      !row[indexes.candidateLast] &&
      !row[indexes.candidateFirst]
    ) {
      const parts = splitFullName_(
        row[indexes.candidateFull]
      );

      row[indexes.candidateLast] = parts.lastName;
      row[indexes.candidateFirst] = parts.firstName;
      row[indexes.candidateMiddle] = parts.middleName;
      changed = true;
    }

    if (
      row[indexes.interviewerFull] &&
      !row[indexes.interviewerLast] &&
      !row[indexes.interviewerFirst]
    ) {
      const parts = splitFullName_(
        row[indexes.interviewerFull]
      );

      row[indexes.interviewerLast] = parts.lastName;
      row[indexes.interviewerFirst] = parts.firstName;
      row[indexes.interviewerMiddle] = parts.middleName;
      changed = true;
    }
  });

  if (changed) {
    range.setValues(values);
  }
}


function migrateSequenceNumbers_() {
  [
    {
      sheet: APP_CONFIG.SHEETS.CANDIDATES,
      id: 'ID'
    },
    {
      sheet: APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES,
      id: 'ID'
    },
    {
      sheet: APP_CONFIG.SHEETS.VACANCIES,
      id: 'Vacancy ID'
    },
    {
      sheet: APP_CONFIG.SHEETS.SOURCES,
      id: 'Source ID'
    },
    {
      sheet: APP_CONFIG.SHEETS.RESPONSIBLES,
      id: 'Responsible ID'
    },
    {
      sheet: APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES,
      id: 'Template ID'
    }
  ].forEach(config => {
    const sheet = getSheet_(config.sheet);

    if (sheet.getLastRow() < 2) {
      return;
    }

    const headers = getHeaders_(sheet);
    const numberIndex = headers.indexOf('№');
    const idIndex = headers.indexOf(config.id);

    if (numberIndex < 0 || idIndex < 0) {
      return;
    }

    const range = sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      headers.length
    );

    const values = range.getValues();

    let max = values.reduce(
      (result, row) => {
        const number = Number(
          row[numberIndex] || 0
        );

        return Number.isFinite(number)
          ? Math.max(result, number)
          : result;
      },
      0
    );

    let changed = false;

    values.forEach(row => {
      if (
        row[idIndex] &&
        !row[numberIndex]
      ) {
        max += 1;
        row[numberIndex] = max;
        changed = true;
      }
    });

    if (changed) {
      range.setValues(values);
    }
  });
}


function migrateResumeVersions_() {
  migrateResumeVersionsForSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  migrateResumeVersionsForSheet_(
    APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES
  );
}


function migrateResumeVersionsForSheet_(sheetName) {
  const sheet = getSheet_(sheetName);

  if (sheet.getLastRow() < 2) {
    return;
  }

  const headers = getHeaders_(sheet);
  const versionsIndex =
    headers.indexOf('Версии резюме');
  const urlIndex =
    headers.indexOf('Резюме');
  const fileIdIndex =
    headers.indexOf('Resume File ID');
  const createdIndex =
    headers.indexOf('Дата добавления');

  if (
    versionsIndex < 0 ||
    urlIndex < 0
  ) {
    return;
  }

  const range = sheet.getRange(
    2,
    1,
    sheet.getLastRow() - 1,
    headers.length
  );

  const values = range.getValues();
  let changed = false;

  values.forEach(row => {
    if (
      !row[versionsIndex] &&
      row[urlIndex]
    ) {
      row[versionsIndex] =
        stringifyJson_([
          {
            id:
              fileIdIndex >= 0
                ? row[fileIdIndex] || ''
                : '',
            url: row[urlIndex],
            name: 'Резюме',
            uploadedAt:
              createdIndex >= 0
                ? row[createdIndex] || ''
                : ''
          }
        ]);

      changed = true;
    }
  });

  if (changed) {
    range.setValues(values);
  }
}


function migrateArchivedCandidates_() {
  const activeSheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  if (activeSheet.getLastRow() < 2) {
    return;
  }

  const archiveSheet = getSheet_(
    APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES
  );

  const activeHeaders =
    getHeaders_(activeSheet);

  const archiveHeaders =
    getHeaders_(archiveSheet);

  const archivedIndex =
    activeHeaders.indexOf('Архивирован');

  const idIndex =
    activeHeaders.indexOf('ID');

  if (
    archivedIndex < 0 ||
    idIndex < 0
  ) {
    return;
  }

  const existingArchiveIds =
    new Set(
      rowsToObjects_(archiveSheet)
        .map(row =>
          String(row.ID || '')
        )
        .filter(Boolean)
    );

  const values = activeSheet
    .getRange(
      2,
      1,
      activeSheet.getLastRow() - 1,
      activeHeaders.length
    )
    .getValues();

  for (
    let index = values.length - 1;
    index >= 0;
    index--
  ) {
    const row = values[index];

    const archived =
      String(
        row[archivedIndex] || ''
      ).toLowerCase() === 'true';

    if (!archived) {
      continue;
    }

    const candidateId =
      String(row[idIndex] || '');

    if (
      candidateId &&
      !existingArchiveIds.has(
        candidateId
      )
    ) {
      const entity =
        objectFromRow_(
          activeHeaders,
          row
        );

      archiveSheet.appendRow(
        archiveHeaders.map(
          header =>
            entity[header] !==
            undefined
              ? entity[header]
              : ''
        )
      );

      existingArchiveIds.add(
        candidateId
      );
    }

    activeSheet.deleteRow(
      index + 2
    );
  }
}
