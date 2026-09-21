function appendCandidateTransitionStatusLog_(input) {
  const candidate =
    input && input.candidate
      ? input.candidate
      : {};

  const responsible =
    input && input.responsible
      ? input.responsible
      : {};

  const changedBy =
    input && input.changedBy
      ? input.changedBy
      : {};

  const entity = {
    'Transition ID':
      Utilities.getUuid(),
    'Candidate ID':
      candidate.ID || '',
    '№ кандидата':
      candidate['№'] || '',
    'ФИО':
      candidate['ФИО'] || '',
    'From Status':
      input && input.fromStatus
        ? input.fromStatus
        : '',
    'To Status':
      input && input.toStatus
        ? input.toStatus
        : '',
    'Responsible ID':
      responsible['Responsible ID'] ||
      candidate['Responsible ID'] ||
      '',
    'Ответственный':
      responsible['ФИО'] ||
      candidate['Ответственный'] ||
      '',
    'Changed By User ID':
      changedBy['User ID'] || '',
    'Changed By':
      changedBy['ФИО'] || '',
    'Changed By Email':
      changedBy.Email || '',
    'Комментарий':
      String(
        input && input.comment || ''
      ).trim(),
    'Дата': formatNow_()
  };

  const sheet = getSheet_(
    APP_CONFIG.SHEETS
      .CANDIDATE_TRANSITION_STATUS_LOG
  );

  const headers =
    getHeaders_(sheet);

  sheet.appendRow(
    headers.map(header =>
      entity[header] !== undefined
        ? entity[header]
        : ''
    )
  );

  return entity;
}


function getCandidateTransitionStatusLog(candidateId) {
  const id = String(
    candidateId || ''
  ).trim();

  if (!id) {
    return [];
  }

  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS
        .CANDIDATE_TRANSITION_STATUS_LOG
    )
  ).filter(item =>
    String(
      item['Candidate ID'] || ''
    ) === id
  );
}
