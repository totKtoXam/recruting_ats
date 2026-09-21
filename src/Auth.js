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
  let token = '';

  try {
    token =
      ScriptApp.getIdentityToken() ||
      '';
  } catch (error) {
    console.warn(
      'Google identity token недоступен: ' +
      (
        error &&
        error.message
          ? error.message
          : String(error)
      )
    );
  }

  let claims = {};

  if (token) {
    try {
      claims =
        decodeIdentityTokenPayload_(
          token
        );
    } catch (error) {
      console.warn(
        'Не удалось декодировать Google identity token: ' +
        (
          error &&
          error.message
            ? error.message
            : String(error)
        )
      );
    }
  }

  const effectiveEmail =
    Session
      .getEffectiveUser()
      .getEmail();

  const activeEmail =
    Session
      .getActiveUser()
      .getEmail();

  const email = String(
    claims.email ||
    effectiveEmail ||
    activeEmail ||
    ''
  )
    .trim()
    .toLowerCase();

  if (!email) {
    throw new Error(
      'Не удалось определить Google Account текущего пользователя. Проверьте, что Web App запущен от имени пользователя и приложению выданы OAuth-разрешения.'
    );
  }

  const googleSubject = String(
    claims.sub || ''
  ).trim();

  return {
    subject:
      googleSubject ||
      'email:' + email,
    googleSubject,
    email,
    fullName: String(
      claims.name ||
      email
    ).trim(),
    avatarUrl: String(
      claims.picture || ''
    ).trim()
  };
}


function getCurrentUser() {
  const identity =
    getCurrentGoogleIdentity_();

  const lock =
    LockService.getUserLock();

  lock.waitLock(30000);

  try {
    const sheet = getSheet_(
      APP_CONFIG.SHEETS.USERS
    );

    const users =
      rowsToObjects_(sheet);

    const bySubject =
      identity.googleSubject
        ? users.filter(user =>
            String(
              user['Google Subject'] ||
              ''
            ) ===
              identity.googleSubject
          )
        : [];

    if (bySubject.length > 1) {
      throw new Error(
        'В таблице пользователей найден дубликат Google Subject.'
      );
    }

    const byEmail =
      users.filter(user =>
        String(
          user.Email || ''
        )
          .trim()
          .toLowerCase() ===
        identity.email
      );

    if (byEmail.length > 1) {
      throw new Error(
        'В таблице пользователей найден дубликат Email.'
      );
    }

    const existing =
      bySubject[0] ||
      byEmail[0] ||
      null;

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

    const nextUser = {
      ...existing,
      'User ID':
        existing &&
        existing['User ID']
          ? existing['User ID']
          : Utilities.getUuid(),
      'Google Subject':
        identity.googleSubject ||
        (
          existing &&
          existing['Google Subject']
            ? existing['Google Subject']
            : identity.subject
        ),
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
    };

    const loginCache =
      CacheService.getScriptCache();

    const cacheKey =
      'ats:last-login:' +
      nextUser['User ID'];

    const profileChanged =
      !existing ||
      String(
        existing['Google Subject'] || ''
      ) !==
        String(
          nextUser['Google Subject'] || ''
        ) ||
      String(existing.Email || '') !==
        String(nextUser.Email || '') ||
      String(existing['ФИО'] || '') !==
        String(nextUser['ФИО'] || '') ||
      String(
        existing['Avatar URL'] || ''
      ) !==
        String(
          nextUser['Avatar URL'] || ''
        );

    if (
      existing &&
      !profileChanged &&
      loginCache.get(cacheKey)
    ) {
      return existing;
    }

    const saved = upsertObject_(
      APP_CONFIG.SHEETS.USERS,
      'User ID',
      nextUser
    );

    loginCache.put(
      cacheKey,
      '1',
      1800
    );

    return saved;
  } finally {
    lock.releaseLock();
  }
}


function toPublicUser_(user) {
  return {
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
  };
}


function getUsers() {
  return rowsToObjects_(
    getSheet_(
      APP_CONFIG.SHEETS.USERS
    )
  )
    .map(toPublicUser_)
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
