const APP_CONFIG = Object.freeze({
  SHEETS: Object.freeze({
    CANDIDATES: 'Кандидаты',
    INTERVIEWS: 'Интервью',
    VACANCIES: 'Вакансии',
    DICTS: 'Справочники'
  }),

  PROPERTIES: Object.freeze({
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    CANDIDATES_FOLDER_ID: 'CANDIDATES_FOLDER_ID'
  }),

  DEFAULT_STATUSES: Object.freeze([
    'Новый',
    'HR screening',
    'Техническое интервью',
    'Финальное интервью',
    'Offer',
    'Hired',
    'Отказ',
    'Резерв'
  ])
});


function getRuntimeConfig_() {
  const props = PropertiesService.getScriptProperties();

  const spreadsheetId = props.getProperty(
    APP_CONFIG.PROPERTIES.SPREADSHEET_ID
  );

  const candidatesFolderId = props.getProperty(
    APP_CONFIG.PROPERTIES.CANDIDATES_FOLDER_ID
  );

  if (!spreadsheetId) {
    throw new Error(
      'Не задан Script Property SPREADSHEET_ID. См. README.md.'
    );
  }

  if (!candidatesFolderId) {
    throw new Error(
      'Не задан Script Property CANDIDATES_FOLDER_ID. См. README.md.'
    );
  }

  return {
    spreadsheetId,
    candidatesFolderId
  };
}
