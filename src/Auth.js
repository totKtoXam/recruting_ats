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

    const matches =
      rowsToObjects_(sheet)
        .filter(user =>
          String(
            user['Google Subject'] || ''
          ) === identity.subject
        );

    if (matches.length > 1) {
      throw new Error(
        'В таблице пользователей найден дубликат Google Subject.'
      );
    }

    const existing =
      matches[0] || null;

    const isActive =
      !existing ||
      existing.IsActive === '' ||
      existing.IsActive === undefined ||
      String(
        existing.IsActive
      ).toLowerCase() === 'true';

    if (!isActive) {
      throw new Error(
        'Доступ для этого Google Account отключён.'
      );
    }

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
        'IsActive':
          existing &&
          existing.IsActive !== '' &&
          existing.IsActive !== undefined
            ? existing.IsActive
            : true,
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
  )
    .map(user => ({
      'User ID':
        user['User ID'] || '',
      'Email':
        user.Email || '',
      'ФИО':
        user['ФИО'] || '',
      'Avatar URL':
        user['Avatar URL'] || '',
      'IsActive':
        user.IsActive,
      'Последний вход':
        user['Последний вход'] || ''
    }))
    .sort((left, right) =>
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
