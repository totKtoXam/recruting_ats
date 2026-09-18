function getCandidates() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.CANDIDATES
    )
  );
}


function getStats() {
  const candidates = getCandidates();
  const byStatus = {};

  candidates.forEach(candidate => {
    const status =
      candidate['Статус'] ||
      'Без статуса';

    byStatus[status] =
      (byStatus[status] || 0) + 1;
  });

  return {
    total: candidates.length,
    byStatus
  };
}


function saveCandidate(payload) {
  validateCandidate_(payload);

  const sheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  let existing = {};
  let rowIndex = -1;
  let headers = getHeaders_(sheet);

  if (!headers.length) {
    throw new Error(
      'Лист "Кандидаты" не содержит заголовков.'
    );
  }

  if (payload.ID) {
    const found = findRowById_(
      sheet,
      'ID',
      payload.ID
    );

    rowIndex = found.rowIndex;

    if (rowIndex > 0) {
      existing = objectFromRow_(
        found.headers,
        found.values
      );
    }
  }

  const candidate = {
    ...existing,
    ...payload
  };

  if (!candidate.ID) {
    candidate.ID = Utilities.getUuid();
  }

  if (!candidate['Статус']) {
    candidate['Статус'] = 'Новый';
  }

  if (!candidate['Дата добавления']) {
    candidate['Дата добавления'] = formatNow_();
  }

  if (!candidate['Папка кандидата']) {
    candidate['Папка кандидата'] =
      ensureCandidateFolder_(
        candidate.ID,
        candidate['ФИО']
      );
  }

  const row = headers.map(header =>
    candidate[header] !== undefined
      ? candidate[header]
      : ''
  );

  if (rowIndex > 0) {
    sheet
      .getRange(
        rowIndex,
        1,
        1,
        headers.length
      )
      .setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return {
    ok: true,
    candidate
  };
}


function validateCandidate_(payload) {
  if (!payload) {
    throw new Error(
      'Пустые данные кандидата.'
    );
  }

  if (
    !String(
      payload['ФИО'] || ''
    ).trim()
  ) {
    throw new Error(
      'Укажите ФИО.'
    );
  }

  if (
    !String(
      payload['Вакансия'] || ''
    ).trim()
  ) {
    throw new Error(
      'Укажите вакансию.'
    );
  }
}


function ensureCandidateFolder_(
  candidateId,
  fullName
) {
  const config = getRuntimeConfig_();

  const root = DriveApp.getFolderById(
    config.candidatesFolderId
  );

  const safeName = String(
    fullName || 'Кандидат'
  ).trim();

  const folderName =
    safeName +
    ' [' +
    String(candidateId).substring(0, 8) +
    ']';

  const existing =
    root.getFoldersByName(folderName);

  const folder =
    existing.hasNext()
      ? existing.next()
      : root.createFolder(folderName);

  return folder.getUrl();
}


function updateCandidateStatus(
  candidateId,
  status
) {
  if (!candidateId) {
    throw new Error(
      'Не указан Candidate ID.'
    );
  }

  if (!status) {
    throw new Error(
      'Не указан статус.'
    );
  }

  const sheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  const found = findRowById_(
    sheet,
    'ID',
    candidateId
  );

  if (found.rowIndex < 0) {
    throw new Error(
      'Кандидат не найден.'
    );
  }

  const statusColumn =
    found.headers.indexOf('Статус');

  if (statusColumn < 0) {
    throw new Error(
      'Не найдена колонка "Статус".'
    );
  }

  sheet
    .getRange(
      found.rowIndex,
      statusColumn + 1
    )
    .setValue(status);

  return {
    ok: true,
    candidateId,
    status
  };
}


function deleteCandidate(candidateId) {
  if (!candidateId) {
    throw new Error(
      'Не указан Candidate ID.'
    );
  }

  const sheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  const found = findRowById_(
    sheet,
    'ID',
    candidateId
  );

  if (found.rowIndex < 0) {
    throw new Error(
      'Кандидат не найден.'
    );
  }

  sheet.deleteRow(
    found.rowIndex
  );

  return {
    ok: true
  };
}
