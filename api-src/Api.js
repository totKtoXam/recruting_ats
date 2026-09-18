const API_CONFIG = Object.freeze({
  DRAFT_SHEET: 'Черновики кандидатов',
  VACANCIES_SHEET: 'Вакансии',
  SOURCES_SHEET: 'Источники',
  RESPONSIBLES_SHEET: 'Ответственные',
  MAX_RESUME_BYTES: 10 * 1024 * 1024,
  DRAFT_TTL_DAYS: 7,
  PROPERTIES: Object.freeze({
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    CANDIDATES_FOLDER_ID: 'CANDIDATES_FOLDER_ID',
    API_KEY: 'ATS_API_KEY',
    UI_WEB_APP_URL: 'UI_WEB_APP_URL'
  })
});


function doGet(event) {
  try {
    ensureApiSchema_();
    requireApiKey_(event, {});

    const action =
      String(
        event &&
        event.parameter &&
        event.parameter.api ||
        ''
      ).trim();

    if (action === 'references') {
      return json_({
        ok: true,
        webAppUrl: getUiWebAppUrl_(),
        vacancies: getRows_(
          API_CONFIG.VACANCIES_SHEET
        )
          .filter(row => !isDeleted_(row))
          .map(row => ({
            id: row['Vacancy ID'],
            number: row['№'],
            name: row['Вакансия'],
            status: row['Статус']
          })),
        sources: getRows_(
          API_CONFIG.SOURCES_SHEET
        )
          .filter(row => !isDeleted_(row))
          .map(row => ({
            id: row['Source ID'],
            number: row['№'],
            name: row['Название']
          })),
        responsibles: getRows_(
          API_CONFIG.RESPONSIBLES_SHEET
        )
          .filter(row => !isDeleted_(row))
          .map(row => ({
            id: row['Responsible ID'],
            number: row['№'],
            lastName: row['Фамилия'],
            firstName: row['Имя'],
            middleName: row['Отчество'],
            fullName: row['ФИО'],
            stages: parseJson_(
              row['Доступные этапы'],
              []
            )
          }))
      });
    }

    if (action === 'meta') {
      return json_({
        ok: true,
        webAppUrl: getUiWebAppUrl_()
      });
    }

    return json_({
      ok: false,
      error: 'Неизвестный API action.'
    });
  } catch (error) {
    return jsonError_(error);
  }
}


function doPost(event) {
  try {
    ensureApiSchema_();

    const body = parseBody_(event);
    requireApiKey_(event, body);

    const action =
      String(
        event &&
        event.parameter &&
        event.parameter.api ||
        body.action ||
        ''
      ).trim();

    if (action === 'candidate-draft') {
      return json_(
        createCandidateDraft_(body)
      );
    }

    return json_({
      ok: false,
      error: 'Неизвестный API action.'
    });
  } catch (error) {
    return jsonError_(error);
  }
}


function setupApiAccess() {
  const props =
    PropertiesService.getScriptProperties();

  let apiKey =
    props.getProperty(
      API_CONFIG.PROPERTIES.API_KEY
    );

  if (!apiKey) {
    apiKey =
      'ats_' +
      Utilities
        .getUuid()
        .replace(/-/g, '');

    props.setProperty(
      API_CONFIG.PROPERTIES.API_KEY,
      apiKey
    );
  }

  return {
    apiKey,
    apiWebAppUrl:
      ScriptApp
        .getService()
        .getUrl(),
    uiWebAppUrl:
      props.getProperty(
        API_CONFIG.PROPERTIES.UI_WEB_APP_URL
      ) || ''
  };
}


function createCandidateDraft_(input) {
  const token =
    Utilities
      .getUuid()
      .replace(/-/g, '');

  const now = new Date();

  const expiresAt =
    new Date(
      now.getTime() +
      API_CONFIG.DRAFT_TTL_DAYS *
      24 * 60 * 60 * 1000
    );

  const data = {
    lastName: clean_(input.lastName),
    firstName: clean_(input.firstName),
    middleName: clean_(input.middleName),
    phone: clean_(input.phone),
    email: clean_(input.email).toLowerCase(),
    telegram: clean_(input.telegram),
    github: clean_(input.github),
    linkedin: clean_(input.linkedin),
    salary: clean_(input.salary),
    vacancyId: clean_(input.vacancyId),
    sourceId: clean_(input.sourceId),
    responsibleId: clean_(input.responsibleId),
    comment: clean_(input.comment),
    links: Array.isArray(input.links)
      ? input.links
      : []
  };

  let resume = {
    id: '',
    name: '',
    url: ''
  };

  if (
    input.resume &&
    input.resume.base64
  ) {
    resume =
      saveDraftResume_(
        token,
        input.resume
      );
  }

  const sheet =
    getSpreadsheet_()
      .getSheetByName(
        API_CONFIG.DRAFT_SHEET
      );

  const headers =
    getHeaders_(sheet);

  const entity = {
    'Draft ID': Utilities.getUuid(),
    'Token': token,
    'Данные': JSON.stringify(data),
    'Resume File ID': resume.id,
    'Resume File Name': resume.name,
    'Resume File URL': resume.url,
    'Дата создания': now.toISOString(),
    'Срок действия': expiresAt.toISOString(),
    'Использован': false,
    'Дата использования': '',
    'Candidate ID': ''
  };

  sheet.appendRow(
    headers.map(header =>
      entity[header] !== undefined
        ? entity[header]
        : ''
    )
  );

  const uiUrl =
    getUiWebAppUrl_();

  return {
    ok: true,
    draftToken: token,
    draftUrl:
      uiUrl +
      '?draft=' +
      encodeURIComponent(token),
    webAppUrl: uiUrl,
    expiresAt:
      expiresAt.toISOString(),
    resume:
      resume.name
        ? resume
        : null
  };
}


function ensureApiSchema_() {
  const ss = getSpreadsheet_();

  let sheet =
    ss.getSheetByName(
      API_CONFIG.DRAFT_SHEET
    );

  if (!sheet) {
    sheet =
      ss.insertSheet(
        API_CONFIG.DRAFT_SHEET
      );
  }

  const required = [
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

  const headers =
    getHeaders_(sheet);

  if (!headers.length) {
    sheet
      .getRange(
        1,
        1,
        1,
        required.length
      )
      .setValues([required]);

    sheet.setFrozenRows(1);
    return;
  }

  const missing =
    required.filter(
      header =>
        !headers.includes(header)
    );

  if (missing.length) {
    sheet
      .getRange(
        1,
        headers.length + 1,
        1,
        missing.length
      )
      .setValues([missing]);
  }
}


function getSpreadsheet_() {
  const id =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        API_CONFIG.PROPERTIES.SPREADSHEET_ID
      );

  if (!id) {
    throw new Error(
      'Не задан Script Property SPREADSHEET_ID.'
    );
  }

  return SpreadsheetApp.openById(id);
}


function getRows_(sheetName) {
  const sheet =
    getSpreadsheet_()
      .getSheetByName(sheetName);

  if (!sheet) {
    return [];
  }

  const values =
    sheet
      .getDataRange()
      .getDisplayValues();

  if (values.length < 2) {
    return [];
  }

  const headers =
    values[0].map(String);

  return values
    .slice(1)
    .filter(row =>
      row.some(value =>
        String(value).trim() !== ''
      )
    )
    .map(row =>
      headers.reduce(
        (result, header, index) => {
          result[header] =
            row[index] || '';
          return result;
        },
        {}
      )
    );
}


function getHeaders_(sheet) {
  if (sheet.getLastColumn() === 0) {
    return [];
  }

  return sheet
    .getRange(
      1,
      1,
      1,
      sheet.getLastColumn()
    )
    .getValues()[0]
    .map(String);
}


function getUiWebAppUrl_() {
  const url =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        API_CONFIG.PROPERTIES.UI_WEB_APP_URL
      );

  if (!url) {
    throw new Error(
      'Не задан Script Property UI_WEB_APP_URL.'
    );
  }

  return url.replace(/\/$/, '');
}


function requireApiKey_(event, body) {
  const expected =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        API_CONFIG.PROPERTIES.API_KEY
      );

  if (!expected) {
    throw new Error(
      'API не настроен. Выполните setupApiAccess().'
    );
  }

  const supplied =
    String(
      event &&
      event.parameter &&
      event.parameter.api_key ||
      body &&
      body.apiKey ||
      ''
    );

  if (
    !supplied ||
    supplied !== expected
  ) {
    throw new Error(
      'Некорректный API key.'
    );
  }
}


function saveDraftResume_(token, file) {
  const bytes =
    Utilities.base64Decode(
      file.base64
    );

  if (
    bytes.length >
    API_CONFIG.MAX_RESUME_BYTES
  ) {
    throw new Error(
      'Размер резюме не должен превышать 10 МБ.'
    );
  }

  const folder =
    getOrCreateDraftFolder_();

  const originalName =
    clean_(
      file.name ||
      'resume'
    );

  const blob =
    Utilities.newBlob(
      bytes,
      file.mimeType ||
        'application/octet-stream',
      token.substring(0, 8) +
        ' - ' +
        originalName
    );

  const saved =
    folder.createFile(blob);

  return {
    id: saved.getId(),
    name: originalName,
    url: saved.getUrl()
  };
}


function getOrCreateDraftFolder_() {
  const folderId =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        API_CONFIG.PROPERTIES.CANDIDATES_FOLDER_ID
      );

  if (!folderId) {
    throw new Error(
      'Не задан Script Property CANDIDATES_FOLDER_ID.'
    );
  }

  const root =
    DriveApp.getFolderById(folderId);

  const name =
    '_ATS_Черновики';

  const folders =
    root.getFoldersByName(name);

  return folders.hasNext()
    ? folders.next()
    : root.createFolder(name);
}


function parseBody_(event) {
  const raw =
    event &&
    event.postData &&
    event.postData.contents
      ? event.postData.contents
      : '';

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      'Body должен быть JSON.'
    );
  }
}


function parseJson_(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}


function isDeleted_(row) {
  return String(
    row &&
    row['Удален'] ||
    ''
  ).toLowerCase() === 'true';
}


function clean_(value) {
  return String(
    value === undefined ||
    value === null
      ? ''
      : value
  ).trim();
}


function jsonError_(error) {
  return json_({
    ok: false,
    error:
      error &&
      error.message
        ? error.message
        : String(error)
  });
}


function json_(value) {
  return ContentService
    .createTextOutput(
      JSON.stringify(value)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}
