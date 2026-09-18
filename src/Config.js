const APP_CONFIG = Object.freeze({
  SHEETS: Object.freeze({
    CANDIDATES: 'Кандидаты',
    ARCHIVED_CANDIDATES: 'Архив кандидатов',
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

  MAX_RESUME_BYTES: 10 * 1024 * 1024,

  // Bootstrap values for the current installation.
  // Google access permissions still protect the underlying resources.
  DEFAULT_SPREADSHEET_ID:
    '1xPEAjQ0O1H680orKt0as06EkYE6BkC8seedxLvHy2os',

  DEFAULT_CANDIDATES_FOLDER_ID:
    '1SAAxC0qYse1gRx9U0pQurfC3Kh_ec0YV'
});


function getRuntimeConfig_() {
  const props = PropertiesService.getScriptProperties();

  const spreadsheetId =
    props.getProperty(
      APP_CONFIG.PROPERTIES.SPREADSHEET_ID
    ) ||
    APP_CONFIG.DEFAULT_SPREADSHEET_ID;

  const candidatesFolderId =
    props.getProperty(
      APP_CONFIG.PROPERTIES.CANDIDATES_FOLDER_ID
    ) ||
    APP_CONFIG.DEFAULT_CANDIDATES_FOLDER_ID;

  return {
    spreadsheetId,
    candidatesFolderId
  };
}
