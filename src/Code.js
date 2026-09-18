function doGet() {
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
  return {
    candidates: getCandidates(),
    vacancies: getVacancies(),
    dictionaries: getDictionaries(),
    stats: getStats()
  };
}
