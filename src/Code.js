function doGet() {
  ensureSchema_();

  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Recruiting ATS')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


function include(filename) {
  return HtmlService
    .createHtmlOutputFromFile(filename)
    .getContent();
}


function getInitialData() {
  ensureSchema_();

  return {
    candidates: getCandidates(),
    vacancies: getVacancies(),
    sources: getSources(),
    responsibles: getResponsibles(),
    interviewTemplates: getInterviewTemplates(),
    dictionaries: getDictionaries(),
    transitions: APP_CONFIG.TRANSITIONS,
    pipelineStatuses: APP_CONFIG.PIPELINE_STATUSES,
    stats: getStats()
  };
}
