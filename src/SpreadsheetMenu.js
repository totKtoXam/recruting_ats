function ensureSpreadsheetMenuTrigger_() {
  const config = getRuntimeConfig_();

  const exists = ScriptApp
    .getProjectTriggers()
    .some(trigger =>
      trigger.getHandlerFunction() ===
        'onSpreadsheetOpen' &&
      trigger.getTriggerSourceId() ===
        config.spreadsheetId
    );

  if (!exists) {
    ScriptApp
      .newTrigger('onSpreadsheetOpen')
      .forSpreadsheet(
        config.spreadsheetId
      )
      .onOpen()
      .create();
  }
}


function onSpreadsheetOpen(event) {
  const spreadsheet =
    event && event.source
      ? event.source
      : getSpreadsheet_();

  spreadsheet
    .getUi()
    .createMenu('Recruiting ATS')
    .addItem(
      'Открыть веб-приложение',
      'openRecruitingAts'
    )
    .addSeparator()
    .addItem(
      'Обновить структуру ATS',
      'setupApplication'
    )
    .addToUi();
}


function openRecruitingAts() {
  const url =
    ScriptApp
      .getService()
      .getUrl();

  if (!url) {
    throw new Error(
      'Web App deployment не найден.'
    );
  }

  const safeUrl = String(url)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = HtmlService
    .createHtmlOutput(
      '<div style="font-family:Arial,sans-serif;padding:16px">' +
      '<p style="margin:0 0 14px">Recruiting ATS</p>' +
      '<a href="' +
      safeUrl +
      '" target="_blank" ' +
      'style="display:inline-block;padding:10px 14px;' +
      'background:#2563eb;color:#fff;text-decoration:none;' +
      'border-radius:8px">Открыть приложение</a>' +
      '</div>'
    )
    .setWidth(320)
    .setHeight(140);

  SpreadsheetApp
    .getUi()
    .showModalDialog(
      html,
      'Recruiting ATS'
    );
}
