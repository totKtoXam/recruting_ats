function doGet(event) {
  ensureSchema_();
  ensureSpreadsheetMenuTrigger_();

  const page =
    event &&
    event.parameter &&
    event.parameter.page === 'admin'
      ? 'Admin'
      : 'Index';

  const template =
    HtmlService.createTemplateFromFile(page);

  template.appUrl =
    ScriptApp
      .getService()
      .getUrl();

  return template
    .evaluate()
    .setTitle(
      page === 'Admin'
        ? 'Recruiting ATS — Админ-панель'
        : 'Recruiting ATS'
    )
    .setXFrameOptionsMode(
      HtmlService.XFrameOptionsMode.ALLOWALL
    );
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
