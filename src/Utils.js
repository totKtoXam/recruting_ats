function getSpreadsheet_() {
  const config = getRuntimeConfig_();

  return SpreadsheetApp.openById(
    config.spreadsheetId
  );
}


function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);

  if (!sheet) {
    throw new Error(
      'Не найден обязательный лист: ' + name
    );
  }

  return sheet;
}


function rowsToObjects_(sheet) {
  const values = sheet
    .getDataRange()
    .getDisplayValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(String);

  return values
    .slice(1)
    .filter(row =>
      row.some(value =>
        String(value).trim() !== ''
      )
    )
    .map(row =>
      headers.reduce((result, header, index) => {
        result[header] = row[index] || '';
        return result;
      }, {})
    );
}


function getHeaders_(sheet) {
  if (sheet.getLastColumn() === 0) {
    return [];
  }

  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(String);
}


function findRowById_(
  sheet,
  idHeader,
  id
) {
  const headers = getHeaders_(sheet);
  const idColumnIndex = headers.indexOf(idHeader);

  if (idColumnIndex < 0) {
    throw new Error(
      'Не найдена колонка: ' + idHeader
    );
  }

  const values = sheet
    .getDataRange()
    .getValues();

  for (let i = 1; i < values.length; i++) {
    if (
      String(values[i][idColumnIndex]) ===
      String(id)
    ) {
      return {
        rowIndex: i + 1,
        headers,
        values: values[i]
      };
    }
  }

  return {
    rowIndex: -1,
    headers,
    values: null
  };
}


function objectFromRow_(
  headers,
  values
) {
  if (!values) {
    return {};
  }

  return headers.reduce(
    (result, header, index) => {
      result[header] = values[index] ?? '';
      return result;
    },
    {}
  );
}


function formatNow_() {
  return Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy-MM-dd HH:mm:ss'
  );
}


function parseJson_(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}


function stringifyJson_(value) {
  return JSON.stringify(value || []);
}


function findById_(
  sheetName,
  idHeader,
  id
) {
  const sheet = getSheet_(sheetName);
  const found = findRowById_(
    sheet,
    idHeader,
    id
  );

  if (found.rowIndex < 0) {
    return null;
  }

  return objectFromRow_(
    found.headers,
    found.values
  );
}


function upsertObject_(
  sheetName,
  idHeader,
  payload
) {
  const sheet = getSheet_(sheetName);
  const headers = getHeaders_(sheet);

  if (!headers.length) {
    throw new Error(
      'Лист "' +
      sheetName +
      '" не содержит заголовков.'
    );
  }

  let rowIndex = -1;
  let existing = {};

  if (payload[idHeader]) {
    const found = findRowById_(
      sheet,
      idHeader,
      payload[idHeader]
    );

    rowIndex = found.rowIndex;

    if (rowIndex > 0) {
      existing = objectFromRow_(
        found.headers,
        found.values
      );
    }
  }

  const entity = {
    ...existing,
    ...payload
  };

  const row = headers.map(header =>
    entity[header] !== undefined
      ? entity[header]
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

  return entity;
}


function deleteRowById_(
  sheetName,
  idHeader,
  id
) {
  const sheet = getSheet_(sheetName);

  const found = findRowById_(
    sheet,
    idHeader,
    id
  );

  if (found.rowIndex < 0) {
    throw new Error(
      'Запись не найдена.'
    );
  }

  sheet.deleteRow(found.rowIndex);

  return {
    ok: true
  };
}


function normalizeKzPhone_(value) {
  const digits = String(value || '')
    .replace(/\D/g, '');

  let normalized = digits;

  if (
    normalized.length === 11 &&
    normalized.startsWith('8')
  ) {
    normalized =
      '7' + normalized.substring(1);
  }

  if (
    normalized.length === 10 &&
    normalized.startsWith('7')
  ) {
    normalized =
      '7' + normalized;
  }

  if (!/^77\d{9}$/.test(normalized)) {
    throw new Error(
      'Телефон должен быть мобильным номером РК в формате +7 7XX XXX XX XX.'
    );
  }

  return (
    '+7 ' +
    normalized.substring(1, 4) +
    ' ' +
    normalized.substring(4, 7) +
    ' ' +
    normalized.substring(7, 9) +
    ' ' +
    normalized.substring(9, 11)
  );
}


function validateEmail_(value) {
  const email = String(value || '').trim();

  if (!email) {
    return '';
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error(
      'Некорректный email.'
    );
  }

  return email;
}


function normalizeTelegram_(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return {
      display: '',
      url: ''
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    return {
      display: raw,
      url: raw
    };
  }

  const username = raw
    .replace(/^@/, '')
    .replace(/^t\.me\//i, '')
    .trim();

  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new Error(
      'Telegram должен быть ссылкой или username длиной 5–32 символа.'
    );
  }

  return {
    display: '@' + username,
    url: 'https://t.me/' + username
  };
}


function validateHttpUrl_(value) {
  const url = String(value || '').trim();

  if (!url) {
    return '';
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      'Ссылка должна начинаться с http:// или https://'
    );
  }

  return url;
}
