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
    'Source ID',
    'Источник',
    'Зарплатные ожидания',
    'Responsible ID',
    'Ответственный',
    'Резюме',
    'Resume File ID',
    'Папка кандидата',
    'Комментарий',
    'Иные ссылки',
    'Дата добавления',
    'Дата изменения',
    'Архивирован',
    'Дата архивации',
    'Причина отказа'
  ];

  schemas[APP_CONFIG.SHEETS.INTERVIEWS] = [
    'Interview ID',
    'Candidate ID',
    'ФИО',
    'Vacancy ID',
    'Вакансия',
    'Этап',
    'From Status',
    'To Status',
    'Template ID',
    'Шаблон',
    'Дата',
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
    'Название',
    'Дата создания',
    'Дата изменения',
    'Удален',
    'Дата удаления'
  ];

  schemas[APP_CONFIG.SHEETS.RESPONSIBLES] = [
    'Responsible ID',
    'Фамилия',
    'Имя',
    'Отчество',
    'ФИО',
    'Email',
    'Доступные этапы',
    'Дата создания',
    'Дата изменения',
    'Удален',
    'Дата удаления'
  ];

  schemas[APP_CONFIG.SHEETS.INTERVIEW_TEMPLATES] = [
    'Template ID',
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
