function getVacancies() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.VACANCIES
    )
  );
}


function getDictionaries() {
  const sheet = getSheet_(
    APP_CONFIG.SHEETS.DICTS
  );

  const values = sheet
    .getDataRange()
    .getDisplayValues();

  if (!values.length) {
    return {};
  }

  const headers = values[0];
  const result = {};

  headers.forEach(
    (header, columnIndex) => {
      if (!header) {
        return;
      }

      result[header] = values
        .slice(1)
        .map(row =>
          row[columnIndex]
        )
        .filter(Boolean);
    }
  );

  return result;
}
