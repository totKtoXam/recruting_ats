function createCandidateDraft_(input) {
  ensureSchema_();

  const payload = input || {};

  const token =
    Utilities.getUuid()
      .replace(/-/g, '');

  const now = new Date();

  const expiresAt =
    new Date(
      now.getTime() +
      APP_CONFIG.DRAFT_TTL_DAYS *
      24 * 60 * 60 * 1000
    );

  const data = {
    lastName:
      normalizeNamePart_(
        payload.lastName
      ),
    firstName:
      normalizeNamePart_(
        payload.firstName
      ),
    middleName:
      normalizeNamePart_(
        payload.middleName
      ),
    phone:
      String(
        payload.phone || ''
      ).trim(),
    email:
      String(
        payload.email || ''
      ).trim().toLowerCase(),
    telegram:
      String(
        payload.telegram || ''
      ).trim(),
    github:
      String(
        payload.github || ''
      ).trim(),
    linkedin:
      String(
        payload.linkedin || ''
      ).trim(),
    salary:
      String(
        payload.salary || ''
      ).trim(),
    vacancyId:
      String(
        payload.vacancyId || ''
      ).trim(),
    sourceId:
      String(
        payload.sourceId || ''
      ).trim(),
    responsibleId:
      String(
        payload.responsibleId || ''
      ).trim(),
    comment:
      String(
        payload.comment || ''
      ).trim(),
    links:
      Array.isArray(payload.links)
        ? payload.links
        : []
  };

  let resume = {
    id: '',
    name: '',
    url: ''
  };

  if (
    payload.resume &&
    payload.resume.base64
  ) {
    resume =
      saveDraftResume_(
        token,
        payload.resume
      );
  }

  const entity = {
    'Draft ID':
      Utilities.getUuid(),
    'Token':
      token,
    'Данные':
      stringifyJson_(data),
    'Resume File ID':
      resume.id,
    'Resume File Name':
      resume.name,
    'Resume File URL':
      resume.url,
    'Дата создания':
      now.toISOString(),
    'Срок действия':
      expiresAt.toISOString(),
    'Использован':
      false,
    'Дата использования':
      '',
    'Candidate ID':
      ''
  };

  upsertObject_(
    APP_CONFIG.SHEETS.CANDIDATE_DRAFTS,
    'Draft ID',
    entity
  );

  const appUrl =
    ScriptApp
      .getService()
      .getUrl();

  return {
    ok: true,
    draftToken:
      token,
    draftUrl:
      appUrl +
      '?draft=' +
      encodeURIComponent(token),
    webAppUrl:
      appUrl,
    expiresAt:
      expiresAt.toISOString(),
    resume:
      resume.name
        ? resume
        : null
  };
}


function getCandidateDraft(token) {
  ensureSchema_();

  const draft =
    getCandidateDraftRecord_(
      token,
      true
    );

  return {
    token:
      draft['Token'],
    data:
      parseJson_(
        draft['Данные'],
        {}
      ),
    resume:
      draft[
        'Resume File ID'
      ]
        ? {
            id:
              draft[
                'Resume File ID'
              ],
            name:
              draft[
                'Resume File Name'
              ] || 'Резюме',
            url:
              draft[
                'Resume File URL'
              ] || ''
          }
        : null,
    expiresAt:
      draft[
        'Срок действия'
      ]
  };
}


function getCandidateDraftRecord_(
  token,
  requireActive
) {
  const cleanToken =
    String(token || '').trim();

  if (!cleanToken) {
    throw new Error(
      'Не указан token черновика.'
    );
  }

  const sheet =
    getSheet_(
      APP_CONFIG.SHEETS.CANDIDATE_DRAFTS
    );

  const found =
    findRowById_(
      sheet,
      'Token',
      cleanToken
    );

  if (found.rowIndex < 0) {
    throw new Error(
      'Черновик кандидата не найден.'
    );
  }

  const draft =
    objectFromRow_(
      found.headers,
      found.values
    );

  if (requireActive) {
    const used =
      String(
        draft['Использован'] || ''
      ).toLowerCase() === 'true';

    if (used) {
      throw new Error(
        'Черновик уже использован.'
      );
    }

    const expiresAt =
      new Date(
        draft[
          'Срок действия'
        ]
      );

    if (
      Number.isFinite(
        expiresAt.getTime()
      ) &&
      expiresAt.getTime() <
        Date.now()
    ) {
      throw new Error(
        'Срок действия черновика истёк.'
      );
    }
  }

  return draft;
}


function saveDraftResume_(
  token,
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

  const folder =
    getOrCreateDraftFolder_();

  const originalName =
    String(
      file.name ||
      'resume'
    ).trim();

  const name =
    token.substring(0, 8) +
    ' - ' +
    originalName;

  const blob =
    Utilities.newBlob(
      bytes,
      file.mimeType ||
        'application/octet-stream',
      name
    );

  const saved =
    folder.createFile(blob);

  return {
    id:
      saved.getId(),
    name:
      originalName,
    url:
      saved.getUrl()
  };
}


function getOrCreateDraftFolder_() {
  const config =
    getRuntimeConfig_();

  const root =
    DriveApp.getFolderById(
      config.candidatesFolderId
    );

  const name =
    '_ATS_Черновики';

  const folders =
    root.getFoldersByName(name);

  return folders.hasNext()
    ? folders.next()
    : root.createFolder(name);
}


function copyDraftResumeToCandidate_(
  token,
  candidateFolder
) {
  if (!token) {
    return null;
  }

  const draft =
    getCandidateDraftRecord_(
      token,
      true
    );

  const fileId =
    draft[
      'Resume File ID'
    ];

  if (!fileId) {
    return null;
  }

  const source =
    DriveApp.getFileById(
      fileId
    );

  const originalName =
    draft[
      'Resume File Name'
    ] ||
    source.getName();

  const now =
    formatNow_();

  const copyName =
    now
      .replace(/[: ]/g, '-') +
    ' - ' +
    originalName;

  const copy =
    source.makeCopy(
      copyName,
      candidateFolder
    );

  return {
    id:
      copy.getId(),
    url:
      copy.getUrl(),
    name:
      originalName,
    uploadedAt:
      now
  };
}


function markCandidateDraftUsed_(
  token,
  candidateId
) {
  if (!token) {
    return;
  }

  const sheet =
    getSheet_(
      APP_CONFIG.SHEETS.CANDIDATE_DRAFTS
    );

  const found =
    findRowById_(
      sheet,
      'Token',
      token
    );

  if (found.rowIndex < 0) {
    return;
  }

  const entity =
    objectFromRow_(
      found.headers,
      found.values
    );

  entity['Использован'] =
    true;

  entity[
    'Дата использования'
  ] =
    new Date().toISOString();

  entity['Candidate ID'] =
    candidateId;

  sheet
    .getRange(
      found.rowIndex,
      1,
      1,
      found.headers.length
    )
    .setValues([
      found.headers.map(
        header =>
          entity[header] !==
          undefined
            ? entity[header]
            : ''
      )
    ]);
}


function cleanupExpiredCandidateDrafts() {
  ensureSchema_();

  const sheet =
    getSheet_(
      APP_CONFIG.SHEETS.CANDIDATE_DRAFTS
    );

  if (sheet.getLastRow() < 2) {
    return {
      ok: true,
      removed: 0
    };
  }

  const headers =
    getHeaders_(sheet);

  const expiresIndex =
    headers.indexOf(
      'Срок действия'
    );

  const usedIndex =
    headers.indexOf(
      'Использован'
    );

  const fileIdIndex =
    headers.indexOf(
      'Resume File ID'
    );

  const values =
    sheet
      .getRange(
        2,
        1,
        sheet.getLastRow() - 1,
        headers.length
      )
      .getValues();

  let removed = 0;

  for (
    let index =
      values.length - 1;
    index >= 0;
    index--
  ) {
    const row =
      values[index];

    const expiresAt =
      new Date(
        row[expiresIndex]
      );

    const used =
      String(
        row[usedIndex] || ''
      ).toLowerCase() === 'true';

    const expired =
      Number.isFinite(
        expiresAt.getTime()
      ) &&
      expiresAt.getTime() <
        Date.now();

    if (!used && !expired) {
      continue;
    }

    const fileId =
      row[fileIdIndex];

    if (fileId) {
      try {
        DriveApp
          .getFileById(fileId)
          .setTrashed(true);
      } catch (error) {
        // Ignore already deleted files.
      }
    }

    sheet.deleteRow(
      index + 2
    );

    removed += 1;
  }

  return {
    ok: true,
    removed
  };
}
