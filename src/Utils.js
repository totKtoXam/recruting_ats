function getSpreadsheet_() {
  const config = getRuntimeConfig_();

  return SpreadsheetApp.openById(
    config.spreadsheetId
  );
}


function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);

  if (!sheet) {
    throw new Error(
      'Не найден обязательный лист: ' + name
    );
  }

  return sheet;
}


function rowsToObjects_(sheet) {
  const values = sheet
    .getDataRange()
    .getDisplayValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(String);

  return values
    .slice(1)
    .filter(row =>
      row.some(value =>
        String(value).trim() !== ''
      )
    )
    .map(row =>
      headers.reduce((result, header, index) => {
        result[header] = row[index] || '';
        return result;
      }, {})
    );
}


function getHeaders_(sheet) {
  if (sheet.getLastColumn() === 0) {
    return [];
  }

  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(String);
}


function findRowById_(
  sheet,
  idHeader,
  id
) {
  const headers = getHeaders_(sheet);
  const idColumnIndex = headers.indexOf(idHeader);

  if (idColumnIndex < 0) {
    throw new Error(
      'Не найдена колонка: ' + idHeader
    );
  }

  const values = sheet
    .getDataRange()
    .getValues();

  for (let i = 1; i < values.length; i++) {
    if (
      String(values[i][idColumnIndex]) ===
      String(id)
    ) {
      return {
        rowIndex: i + 1,
        headers,
        values: values[i]
      };
    }
  }

  return {
    rowIndex: -1,
    headers,
    values: null
  };
}


function objectFromRow_(
  headers,
  values
) {
  if (!values) {
    return {};
  }

  return headers.reduce(
    (result, header, index) => {
      result[header] = values[index] ?? '';
      return result;
    },
    {}
  );
}


function formatNow_() {
  return Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy-MM-dd HH:mm:ss'
  );
}
