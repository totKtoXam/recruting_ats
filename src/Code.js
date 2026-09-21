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


function getReferenceData() {
  return {
    vacancies: getVacancies(),
    sources: getSources(),
    responsibles: getResponsibles(),
    interviewTemplates: getInterviewTemplates(),
    dictionaries: getDictionaries(),
    transitions: APP_CONFIG.TRANSITIONS,
    pipelineStatuses: APP_CONFIG.PIPELINE_STATUSES
  };
}


function getCandidateData() {
  const candidates = getCandidates();

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
      getArchivedCandidates()
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
    getCurrentUser();

  const references =
    getReferenceData();

  const candidates =
    getCandidates();

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
