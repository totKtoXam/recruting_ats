function mapCandidate_(candidate, archivedOverride) {
  const fallback =
    splitFullName_(candidate['ФИО']);

  return {
    ...candidate,
    'Фамилия':
      candidate['Фамилия'] ||
      fallback.lastName,
    'Имя':
      candidate['Имя'] ||
      fallback.firstName,
    'Отчество':
      candidate['Отчество'] ||
      fallback.middleName,
    links: parseJson_(
      candidate['Иные ссылки'],
      []
    ),
    resumeVersions: parseJson_(
      candidate['Версии резюме'],
      []
    ),
    archived:
      archivedOverride !== undefined
        ? archivedOverride
        : String(
            candidate['Архивирован'] || ''
          ).toLowerCase() === 'true'
  };
}


function getCandidates() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.CANDIDATES
    )
  ).map(candidate =>
    mapCandidate_(
      candidate,
      false
    )
  );
}


function getArchivedCandidates() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES
    )
  ).map(candidate =>
    mapCandidate_(
      candidate,
      true
    )
  );
}


function getStats() {
  const active = getCandidates();
  const archived =
    getArchivedCandidates();

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
    archived: archived.length,
    byStatus
  };
}


function getNextCandidateNumber_() {
  const numbers = [
    ...getCandidates(),
    ...getArchivedCandidates()
  ]
    .map(candidate =>
      Number(
        candidate['№'] || 0
      )
    )
    .filter(Number.isFinite);

  return (
    numbers.length
      ? Math.max(...numbers)
      : 0
  ) + 1;
}


function findCandidateStorage_(candidateId) {
  const activeSheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  const active = findRowById_(
    activeSheet,
    'ID',
    candidateId
  );

  if (active.rowIndex >= 0) {
    return {
      sheet: activeSheet,
      found: active,
      archived: false
    };
  }

  const archiveSheet = getSheet_(
    APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES
  );

  const archived = findRowById_(
    archiveSheet,
    'ID',
    candidateId
  );

  if (archived.rowIndex >= 0) {
    return {
      sheet: archiveSheet,
      found: archived,
      archived: true
    };
  }

  return null;
}


function saveCandidate(payload) {
  validateCandidate_(payload);

  const isNew = !payload.ID;

  let sheet = getSheet_(
    APP_CONFIG.SHEETS.CANDIDATES
  );

  let headers =
    getHeaders_(sheet);

  let existing = {};
  let rowIndex = -1;
  let isArchivedStorage = false;

  if (!isNew) {
    const storage =
      findCandidateStorage_(
        payload.ID
      );

    if (!storage) {
      throw new Error(
        'Кандидат не найден.'
      );
    }

    sheet = storage.sheet;
    headers =
      storage.found.headers;
    rowIndex =
      storage.found.rowIndex;
    isArchivedStorage =
      storage.archived;

    existing = objectFromRow_(
      storage.found.headers,
      storage.found.values
    );
  }

  const vacancyId =
    String(
      payload.vacancyId ||
      existing['Vacancy ID'] ||
      ''
    ).trim();

  const vacancy = findById_(
    APP_CONFIG.SHEETS.VACANCIES,
    'Vacancy ID',
    vacancyId
  );

  if (!vacancy) {
    throw new Error(
      'Выбранная вакансия не найдена.'
    );
  }

  const vacancyChanged =
    String(
      existing['Vacancy ID'] || ''
    ) !== vacancyId;

  if (
    (isNew || vacancyChanged) &&
    (
      isSoftDeleted_(vacancy) ||
      vacancy['Статус'] !==
        'Открыта'
    )
  ) {
    throw new Error(
      'Можно выбрать только открытую вакансию.'
    );
  }

  const responsibleId =
    String(
      payload.responsibleId ||
      existing['Responsible ID'] ||
      ''
    ).trim();

  const responsible = findById_(
    APP_CONFIG.SHEETS.RESPONSIBLES,
    'Responsible ID',
    responsibleId
  );

  if (!responsible) {
    throw new Error(
      'Ответственный не найден.'
    );
  }

  const responsibleChanged =
    String(
      existing[
        'Responsible ID'
      ] || ''
    ) !== responsibleId;

  if (
    (isNew || responsibleChanged) &&
    isSoftDeleted_(responsible)
  ) {
    throw new Error(
      'Выбранный ответственный удалён.'
    );
  }

  const candidateStatus =
    isNew
      ? 'Новый'
      : existing['Статус'] ||
        'Новый';

  const responsibleStages =
    parseJson_(
      responsible[
        'Доступные этапы'
      ],
      []
    );

  if (
    !isArchivedStorage &&
    (isNew || responsibleChanged) &&
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

  const sourceId =
    String(
      payload.sourceId !==
      undefined
        ? payload.sourceId || ''
        : existing[
            'Source ID'
          ] || ''
    ).trim();

  let source = null;

  if (sourceId) {
    source = findById_(
      APP_CONFIG.SHEETS.SOURCES,
      'Source ID',
      sourceId
    );

    if (!source) {
      throw new Error(
        'Источник не найден.'
      );
    }

    const sourceChanged =
      String(
        existing[
          'Source ID'
        ] || ''
      ) !== sourceId;

    if (
      (isNew || sourceChanged) &&
      isSoftDeleted_(source)
    ) {
      throw new Error(
        'Выбранный источник удалён.'
      );
    }
  }

  const lastName =
    normalizeNamePart_(
      payload.lastName !==
      undefined
        ? payload.lastName
        : existing['Фамилия']
    );

  const firstName =
    normalizeNamePart_(
      payload.firstName !==
      undefined
        ? payload.firstName
        : existing['Имя']
    );

  const middleName =
    normalizeNamePart_(
      payload.middleName !==
      undefined
        ? payload.middleName
        : existing['Отчество']
    );

  const fullName =
    composeFullName_(
      lastName,
      firstName,
      middleName
    );

  const telegram =
    normalizeTelegram_(
      payload.telegram !==
      undefined
        ? payload.telegram
        : existing['Telegram']
    );

  const linkedin =
    normalizeProfileUrl_(
      payload.linkedin !==
      undefined
        ? payload.linkedin
        : existing['LinkedIn'],
      'linkedin'
    );

  const github =
    normalizeProfileUrl_(
      payload.github !==
      undefined
        ? payload.github
        : existing['GitHub'],
      'github'
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
    : parseJson_(
        existing[
          'Иные ссылки'
        ],
        []
      );

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

  const salary =
    normalizeMoney_(
      payload.salary !==
      undefined
        ? payload.salary
        : existing[
            'Зарплатные ожидания'
          ]
    );

  if (
    salary !== '' &&
    Number(salary) >
      10000000
  ) {
    throw new Error(
      'ЗП ожидания не может превышать 10 000 000.'
    );
  }

  const candidateId =
    existing.ID ||
    Utilities.getUuid();

  const candidateNumber =
    existing['№'] ||
    getNextCandidateNumber_();

  const folderInfo =
    ensureCandidateFolder_(
      candidateId,
      fullName,
      existing[
        'Папка кандидата'
      ]
    );

  let resumeVersions =
    parseJson_(
      existing[
        'Версии резюме'
      ],
      []
    );

  if (
    !resumeVersions.length &&
    existing['Резюме']
  ) {
    resumeVersions = [
      {
        id:
          existing[
            'Resume File ID'
          ] || '',
        url:
          existing['Резюме'],
        name: 'Резюме',
        uploadedAt:
          existing[
            'Дата добавления'
          ] || ''
      }
    ];
  }

  if (payload.resumeFile) {
    const uploaded =
      saveResumeFile_(
        folderInfo.folder,
        payload.resumeFile
      );

    resumeVersions = [
      uploaded,
      ...resumeVersions
    ];
  }

  if (
    isNew &&
    !resumeVersions.length
  ) {
    throw new Error(
      'Резюме обязательно.'
    );
  }

  const latestResume =
    resumeVersions[0] || {};

  const now = formatNow_();

  const candidate = {
    ...existing,
    'ID': candidateId,
    '№': candidateNumber,
    'Фамилия': lastName,
    'Имя': firstName,
    'Отчество': middleName,
    'ФИО': fullName,
    'Vacancy ID': vacancyId,
    'Вакансия':
      vacancy['Вакансия'],
    'Статус':
      candidateStatus,
    'Телефон':
      normalizeKzPhone_(
        payload.phone !==
        undefined
          ? payload.phone
          : existing['Телефон']
      ),
    'Email':
      validateEmail_(
        payload.email !==
        undefined
          ? payload.email
          : existing['Email']
      ),
    'Telegram':
      telegram.display,
    'Telegram URL':
      telegram.url,
    'LinkedIn':
      linkedin,
    'GitHub':
      github,
    'Source ID':
      source
        ? source['Source ID']
        : '',
    'Источник':
      source
        ? source['Название']
        : '',
    'Зарплатные ожидания':
      salary,
    'Responsible ID':
      responsible[
        'Responsible ID'
      ],
    'Ответственный':
      responsible['ФИО'],
    'Резюме':
      latestResume.url || '',
    'Resume File ID':
      latestResume.id || '',
    'Версии резюме':
      stringifyJson_(
        resumeVersions
      ),
    'Папка кандидата':
      folderInfo.url,
    'Комментарий':
      String(
        payload.comment !==
        undefined
          ? payload.comment || ''
          : existing[
              'Комментарий'
            ] || ''
      ).trim(),
    'Иные ссылки':
      stringifyJson_(links),
    'Дата добавления':
      existing[
        'Дата добавления'
      ] || now,
    'Дата изменения': now,
    'Архивирован':
      isArchivedStorage,
    'Дата архивации':
      isArchivedStorage
        ? existing[
            'Дата архивации'
          ] || now
        : '',
    'Причина отказа':
      existing[
        'Причина отказа'
      ] || ''
  };

  const row =
    headers.map(
      header =>
        candidate[header] !==
        undefined
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
    candidate:
      mapCandidate_(
        candidate,
        isArchivedStorage
      )
  };
}


function validateCandidate_(
  payload
) {
  if (!payload) {
    throw new Error(
      'Пустые данные кандидата.'
    );
  }

  if (
    !normalizeNamePart_(
      payload.lastName
    )
  ) {
    throw new Error(
      'Фамилия обязательна.'
    );
  }

  if (
    !normalizeNamePart_(
      payload.firstName
    )
  ) {
    throw new Error(
      'Имя обязательно.'
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


function ensureCandidateFolder_(
  candidateId,
  fullName,
  existingUrl
) {
  const config =
    getRuntimeConfig_();

  const root =
    DriveApp.getFolderById(
      config.candidatesFolderId
    );

  if (existingUrl) {
    const match =
      String(existingUrl)
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

  const safeName =
    String(
      fullName ||
      'Кандидат'
    )
      .trim()
      .replace(
        /[\\/:*?"<>|]/g,
        '_'
      );

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
  const bytes =
    Utilities.base64Decode(
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

  const now = formatNow_();

  const originalName =
    String(
      file.name ||
      'resume'
    ).trim();

  const versionedName =
    now
      .replace(
        /[: ]/g,
        '-'
      ) +
    ' - ' +
    originalName;

  const blob =
    Utilities.newBlob(
      bytes,
      file.mimeType ||
        'application/octet-stream',
      versionedName
    );

  const saved =
    folder.createFile(blob);

  return {
    id:
      saved.getId(),
    url:
      saved.getUrl(),
    name:
      originalName,
    uploadedAt:
      now
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
  const lock =
    LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    const activeSheet =
      getSheet_(
        APP_CONFIG.SHEETS.CANDIDATES
      );

    const found = findRowById_(
      activeSheet,
      'ID',
      candidateId
    );

    if (found.rowIndex < 0) {
      const archived =
        findById_(
          APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES,
          'ID',
          candidateId
        );

      if (archived) {
        return {
          ok: true,
          candidate:
            mapCandidate_(
              archived,
              true
            )
        };
      }

      throw new Error(
        'Кандидат не найден.'
      );
    }

    const candidate =
      objectFromRow_(
        found.headers,
        found.values
      );

    const now = formatNow_();

    candidate[
      'Архивирован'
    ] = true;

    candidate[
      'Дата архивации'
    ] = now;

    candidate[
      'Причина отказа'
    ] =
      candidate[
        'Причина отказа'
      ] || '';

    candidate[
      'Дата изменения'
    ] = now;

    const archiveSheet =
      getSheet_(
        APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES
      );

    const archiveHeaders =
      getHeaders_(archiveSheet);

    const existingArchive =
      findById_(
        APP_CONFIG.SHEETS.ARCHIVED_CANDIDATES,
        'ID',
        candidateId
      );

    if (!existingArchive) {
      archiveSheet.appendRow(
        archiveHeaders.map(
          header =>
            candidate[header] !==
            undefined
              ? candidate[header]
              : ''
        )
      );
    }

    activeSheet.deleteRow(
      found.rowIndex
    );

    return {
      ok: true,
      candidate:
        mapCandidate_(
          candidate,
          true
        )
    };
  } finally {
    lock.releaseLock();
  }
}
