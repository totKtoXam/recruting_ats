function doGet(event) {
  ensureSchemaVersion_();

  const template =
    HtmlService.createTemplateFromFile('Index');

  template.appUrl =
    ScriptApp
      .getService()
      .getUrl();

  template.initialRoute =
    event &&
    event.parameter &&
    event.parameter.page === 'admin'
      ? 'admin'
      : 'candidates';

  template.initialDraftToken =
    event &&
    event.parameter &&
    event.parameter.draft
      ? String(
          event.parameter.draft
        )
      : '';

  return template
    .evaluate()
    .setTitle('Recruiting ATS')
    .setXFrameOptionsMode(
      HtmlService.XFrameOptionsMode.ALLOWALL
    );
}


function include(filename) {
  return HtmlService
    .createHtmlOutputFromFile(filename)
    .getContent();
}


const REFERENCE_CACHE_KEY =
  'ats:reference-data:v' +
  APP_CONFIG.SCHEMA_VERSION;


function getReferenceData() {
  const cache =
    CacheService.getScriptCache();

  const cached =
    cache.get(
      REFERENCE_CACHE_KEY
    );

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      cache.remove(
        REFERENCE_CACHE_KEY
      );
    }
  }

  const data = {
    vacancies: getVacancies(),
    sources: getSources(),
    responsibles: getResponsibles(),
    interviewTemplates: getInterviewTemplates(),
    dictionaries: getDictionaries(),
    transitions: APP_CONFIG.TRANSITIONS,
    pipelineStatuses: APP_CONFIG.PIPELINE_STATUSES
  };

  try {
    cache.put(
      REFERENCE_CACHE_KEY,
      JSON.stringify(data),
      300
    );
  } catch (error) {
    console.warn(
      'Не удалось закэшировать справочники: ' +
      (
        error &&
        error.message
          ? error.message
          : String(error)
      )
    );
  }

  return data;
}


function invalidateReferenceCache_() {
  CacheService
    .getScriptCache()
    .remove(
      REFERENCE_CACHE_KEY
    );
}


function getCandidateData() {
  const candidates =
    getCandidateSummaries();

  return {
    candidates,
    stats: calculateStats_(
      candidates,
      getArchivedCandidateCount_()
    )
  };
}


function getArchivedCandidateData() {
  return {
    archivedCandidates:
      getArchivedCandidateSummaries()
  };
}


function getAdminUserData() {
  return {
    users: getUsers()
  };
}


function getBootstrapData() {
  ensureSchemaVersion_();

  const currentUser =
    toPublicUser_(
      getCurrentUser()
    );

  const references =
    getReferenceData();

  const candidates =
    getCandidateSummaries();

  const stats =
    calculateStats_(
      candidates,
      getArchivedCandidateCount_()
    );

  return {
    currentUser,
    ...references,
    candidates,
    stats
  };
}


function getInitialData() {
  return getBootstrapData();
}
