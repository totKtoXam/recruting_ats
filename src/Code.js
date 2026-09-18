function doGet(event) {
  ensureSchema_();
  ensureSpreadsheetMenuTrigger_();

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
  ensureSchema_();

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
  ensureSchema_();

  return {
    candidates: getCandidates(),
    stats: getStats()
  };
}


function getArchivedCandidateData() {
  ensureSchema_();

  return {
    archivedCandidates:
      getArchivedCandidates()
  };
}


function getInitialData() {
  const references = getReferenceData();
  const candidateData = getCandidateData();
  const archivedData =
    getArchivedCandidateData();

  return {
    ...references,
    ...candidateData,
    ...archivedData
  };
}
