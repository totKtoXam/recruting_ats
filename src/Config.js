const APP_CONFIG = Object.freeze({
  SHEETS: Object.freeze({
    CANDIDATES: 'Кандидаты',
    INTERVIEWS: 'Интервью',
    VACANCIES: 'Вакансии',
    SOURCES: 'Источники',
    RESPONSIBLES: 'Ответственные',
    INTERVIEW_TEMPLATES: 'Шаблоны интервью',
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
    'Отказ'
  ]),

  PIPELINE_STATUSES: Object.freeze([
    'Новый',
    'HR screening',
    'Техническое интервью',
    'Финальное интервью',
    'Offer',
    'Hired'
  ]),

  VACANCY_STATUSES: Object.freeze([
    'Открыта',
    'На паузе',
    'Закрыта'
  ]),

  TRANSITIONS: Object.freeze({
    'Новый': ['HR screening'],
    'HR screening': ['Новый', 'Техническое интервью'],
    'Техническое интервью': ['HR screening', 'Финальное интервью'],
    'Финальное интервью': ['Техническое интервью', 'Offer'],
    'Offer': ['Финальное интервью', 'Hired'],
    'Hired': ['Offer']
  }),

  MAX_RESUME_BYTES: 10 * 1024 * 1024
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
