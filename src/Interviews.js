function getInterviews(candidateId) {
  if (!candidateId) {
    return [];
  }

  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.INTERVIEWS
    )
  ).filter(interview =>
    String(
      interview['Candidate ID']
    ) === String(candidateId)
  );
}


function addInterview(payload) {
  if (
    !payload ||
    !payload['Candidate ID']
  ) {
    throw new Error(
      'Не указан Candidate ID.'
    );
  }

  const sheet = getSheet_(
    APP_CONFIG.SHEETS.INTERVIEWS
  );

  const headers = getHeaders_(sheet);

  if (!headers.length) {
    throw new Error(
      'Лист "Интервью" не содержит заголовков.'
    );
  }

  const interview = {
    ...payload,
    'Interview ID':
      payload['Interview ID'] ||
      Utilities.getUuid(),
    'Дата':
      payload['Дата'] ||
      formatNow_()
  };

  const row = headers.map(header =>
    interview[header] !== undefined
      ? interview[header]
      : ''
  );

  sheet.appendRow(row);

  return {
    ok: true,
    interview
  };
}
