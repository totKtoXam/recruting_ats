function getCandidates() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.CANDIDATES
    )
  ).map(candidate => ({
    ...candidate,
    links: parseJson_(
      candidate['Иные ссылки'],
      []
    ),
    archived:
      String(
        candidate['Архивирован'] || ''
      ).toLowerCase() === 'true'
  }));
}


function getStats() {
  const candidates = getCandidates();
  const active = candidates.filter(
    candidate =>
      !candidate.archived
  );

  const byStatus = {};

  active.forEach(candidate => {
    const status =
      candidate['Статус'] ||
      'Без статуса';

    byStatus[status] =
      (byStatus[status] || 0) + 1;
  });

  return {
    total: active.length,
    archived:
      candidates.length -
      active.length,
    byStatus
  };
}


function saveCandidate(payload) {
  validateCandidate_(payload);

  const isNew = !payload.ID;
  const sheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  let existing = {};
  let rowIndex = -1;
  const headers = getHeaders_(sheet);

  if (payload.ID) {
    const found = findRowById_(
      sheet,
      'ID',
      payload.ID
    );

    rowIndex = found.rowIndex;

    if (rowIndex < 0) {
      throw new Error(
        'Кандидат не найден.'
      );
    }

    existing = objectFromRow_(
      found.headers,
      found.values
    );
  }

  const vacancy = findById_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    payload.vacancyId
  );

  if (!vacancy) {
    throw new Error(
      'Выбранная вакансия не найдена.'
    );
  }

  if (
    isNew &&
    vacancy['Статус'] !== 'Открыта'
  ) {
    throw new Error(
      'Нового кандидата можно добавить только на открытую вакансию.'
    );
  }

  const responsible = findById_(
    APP_CONFIG.SHEETS.RESPONSIBLES,
    'Responsible ID',
    payload.responsibleId
  );

  if (!responsible) {
    throw new Error(
      'Ответственный не найден.'
    );
  }

  const responsibleStages = parseJson_(
    responsible['Доступные этапы'],
    []
  );

  const candidateStatus =
    isNew
      ? 'Новый'
      : existing['Статус'];

  if (
    !responsibleStages.includes(
      candidateStatus
    )
  ) {
    throw new Error(
      'Выбранный ответственный недоступен для этапа "' +
      candidateStatus +
      '".'
    );
  }

  let source = null;

  if (payload.sourceId) {
    source = findById_(
      APP_CONFIG.SHEETS.SOURCES,
      'Source ID',
      payload.sourceId
    );

    if (!source) {
      throw new Error(
        'Источник не найден.'
      );
    }
  }

  const telegram = normalizeTelegram_(
    payload.telegram
  );

  const links = Array.isArray(
    payload.links
  )
    ? payload.links
        .map(link => ({
          name:
            String(
              link.name || ''
            ).trim(),
          url:
            validateHttpUrl_(
              link.url
            )
        }))
        .filter(link =>
          link.name ||
          link.url
        )
    : [];

  links.forEach(link => {
    if (
      !link.name ||
      !link.url
    ) {
      throw new Error(
        'Для иной ссылки необходимо заполнить и название, и URL.'
      );
    }
  });

  const candidateId =
    existing.ID ||
    Utilities.getUuid();

  const folderInfo =
    ensureCandidateFolder_(
      candidateId,
      payload.fullName,
      existing['Папка кандидата']
    );

  let resumeUrl =
    existing['Резюме'] || '';

  let resumeFileId =
    existing['Resume File ID'] || '';

  if (payload.resumeFile) {
    const uploaded =
      saveResumeFile_(
        folderInfo.folder,
        payload.resumeFile
      );

    resumeUrl = uploaded.url;
    resumeFileId = uploaded.id;
  }

  if (
    isNew &&
    !resumeUrl
  ) {
    throw new Error(
      'Резюме обязательно.'
    );
  }

  const now = formatNow_();

  const candidate = {
    ...existing,
    'ID': candidateId,
    'ФИО':
      String(payload.fullName).trim(),
    'Vacancy ID':
      payload.vacancyId,
    'Вакансия':
      vacancy['Вакансия'],
    'Статус':
      candidateStatus,
    'Телефон':
      normalizeKzPhone_(
        payload.phone
      ),
    'Email':
      validateEmail_(
        payload.email
      ),
    'Telegram':
      telegram.display,
    'Telegram URL':
      telegram.url,
    'Source ID':
      source
        ? source['Source ID']
        : '',
    'Источник':
      source
        ? source['Название']
        : '',
    'Зарплатные ожидания':
      normalizeMoney_(
        payload.salary
      ),
    'Responsible ID':
      responsible['Responsible ID'],
    'Ответственный':
      responsible['ФИО'],
    'Резюме':
      resumeUrl,
    'Resume File ID':
      resumeFileId,
    'Папка кандидата':
      folderInfo.url,
    'Комментарий':
      String(
        payload.comment || ''
      ).trim(),
    'Иные ссылки':
      stringifyJson_(links),
    'Дата добавления':
      existing['Дата добавления'] ||
      now,
    'Дата изменения': now,
    'Архивирован':
      existing['Архивирован'] ||
      false,
    'Дата архивации':
      existing['Дата архивации'] ||
      '',
    'Причина отказа':
      existing['Причина отказа'] ||
      ''
  };

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
    candidate: {
      ...candidate,
      links,
      archived: false
    }
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
      payload.fullName || ''
    ).trim()
  ) {
    throw new Error(
      'ФИО обязательно.'
    );
  }

  if (!payload.vacancyId) {
    throw new Error(
      'Вакансия обязательна.'
    );
  }

  if (!payload.phone) {
    throw new Error(
      'Телефон обязателен.'
    );
  }

  if (!payload.responsibleId) {
    throw new Error(
      'Ответственный обязателен.'
    );
  }
}


function normalizeMoney_(value) {
  const raw = String(value || '')
    .replace(/\s/g, '')
    .replace(/,/g, '.');

  if (!raw) {
    return '';
  }

  const number = Number(raw);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    throw new Error(
      'Некорректное значение зарплатных ожиданий.'
    );
  }

  return Math.round(number);
}


function ensureCandidateFolder_(
  candidateId,
  fullName,
  existingUrl
) {
  const config = getRuntimeConfig_();
  const root = DriveApp.getFolderById(
    config.candidatesFolderId
  );

  if (existingUrl) {
    const match = String(existingUrl)
      .match(
        /\/folders\/([A-Za-z0-9_-]+)/
      );

    if (match) {
      try {
        const folder =
          DriveApp.getFolderById(
            match[1]
          );

        return {
          folder,
          url:
            folder.getUrl()
        };
      } catch (error) {
        // Recreate below.
      }
    }
  }

  const safeName = String(
    fullName || 'Кандидат'
  )
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_');

  const uniqueNumber =
    String(candidateId)
      .replace(/-/g, '')
      .substring(0, 8)
      .toUpperCase();

  const folderName =
    safeName +
    ' - ' +
    uniqueNumber;

  const existing =
    root.getFoldersByName(
      folderName
    );

  const folder =
    existing.hasNext()
      ? existing.next()
      : root.createFolder(
          folderName
        );

  return {
    folder,
    url:
      folder.getUrl()
  };
}


function saveResumeFile_(
  folder,
  file
) {
  const bytes = Utilities
    .base64Decode(
      file.base64
    );

  if (
    bytes.length >
    APP_CONFIG.MAX_RESUME_BYTES
  ) {
    throw new Error(
      'Размер резюме не должен превышать 10 МБ.'
    );
  }

  const blob = Utilities.newBlob(
    bytes,
    file.mimeType ||
      'application/octet-stream',
    file.name ||
      'resume'
  );

  const saved =
    folder.createFile(blob);

  return {
    id:
      saved.getId(),
    url:
      saved.getUrl()
  };
}


function getAllowedTransitions(
  candidateId
) {
  const candidate = findById_(
    APP_CONFIG.SHEETS.CANDIDATES,
    'ID',
    candidateId
  );

  if (!candidate) {
    throw new Error(
      'Кандидат не найден.'
    );
  }

  if (
    String(
      candidate['Архивирован']
    ).toLowerCase() === 'true'
  ) {
    return [];
  }

  return (
    APP_CONFIG.TRANSITIONS[
      candidate['Статус']
    ] || []
  );
}


function archiveCandidate(
  candidateId
) {
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

  const candidate = objectFromRow_(
    found.headers,
    found.values
  );

  const now = formatNow_();

  candidate['Статус'] = 'Отказ';
  candidate['Архивирован'] = true;
  candidate['Дата архивации'] = now;
  candidate['Причина отказа'] =
    'Архивация';
  candidate['Дата изменения'] = now;

  const row = found.headers.map(
    header =>
      candidate[header] !== undefined
        ? candidate[header]
        : ''
  );

  sheet
    .getRange(
      found.rowIndex,
      1,
      1,
      found.headers.length
    )
    .setValues([row]);

  return {
    ok: true
  };
}
