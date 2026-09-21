function decodeIdentityTokenPayload_(token) {
  const parts = String(token || '').split('.');

  if (parts.length !== 3) {
    throw new Error(
      'Не удалось определить Google-пользователя.'
    );
  }

  let payload = parts[1];

  while (payload.length % 4) {
    payload += '=';
  }

  const decoded = Utilities
    .newBlob(
      Utilities.base64DecodeWebSafe(payload)
    )
    .getDataAsString();

  return JSON.parse(decoded);
}


function getCurrentGoogleIdentity_() {
  const token = ScriptApp.getIdentityToken();

  if (!token) {
    throw new Error(
      'Google-авторизация недоступна. Войдите в приложение через Google Account.'
    );
  }

  const claims =
    decodeIdentityTokenPayload_(token);

  const subject = String(
    claims.sub || ''
  ).trim();

  if (!subject) {
    throw new Error(
      'Google Account не содержит идентификатор sub.'
    );
  }

  const email = String(
    claims.email ||
    Session
      .getActiveUser()
      .getEmail() ||
    ''
  )
    .trim()
    .toLowerCase();

  return {
    subject,
    email,
    fullName: String(
      claims.name ||
      email ||
      'Google User'
    ).trim(),
    avatarUrl: String(
      claims.picture || ''
    ).trim()
  };
}


function getCurrentUser() {
  ensureSchema_();

  const identity =
    getCurrentGoogleIdentity_();

  const lock =
    LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    const sheet = getSheet_(
      APP_CONFIG.SHEETS.USERS
    );

    const existing =
      rowsToObjects_(sheet)
        .find(user =>
          String(
            user['Google Subject'] || ''
          ) === identity.subject
        ) || null;

    const now = formatNow_();

    return upsertObject_(
      APP_CONFIG.SHEETS.USERS,
      'User ID',
      {
        ...existing,
        'User ID':
          existing &&
          existing['User ID']
            ? existing['User ID']
            : Utilities.getUuid(),
        'Google Subject':
          identity.subject,
        'Email':
          identity.email,
        'ФИО':
          identity.fullName,
        'Avatar URL':
          identity.avatarUrl,
        'Дата создания':
          existing &&
          existing['Дата создания']
            ? existing['Дата создания']
            : now,
        'Последний вход': now
      }
    );
  } finally {
    lock.releaseLock();
  }
}


function getUsers() {
  ensureSchema_();

  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.USERS
    )
  ).sort((left, right) =>
    String(
      left['ФИО'] ||
      left.Email ||
      ''
    ).localeCompare(
      String(
        right['ФИО'] ||
        right.Email ||
        ''
      ),
      'ru'
    )
  );
}
