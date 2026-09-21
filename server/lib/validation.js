import { fail } from './errors.js';

export function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function normalizeNamePart(value) {
  return clean(value).replace(/\s+/g, ' ');
}

export function composeFullName(lastName, firstName, middleName) {
  return [lastName, firstName, middleName]
    .map(normalizeNamePart)
    .filter(Boolean)
    .join(' ');
}

export function splitFullName(fullName) {
  const parts = clean(fullName).split(/\s+/).filter(Boolean);

  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    middleName: parts.slice(2).join(' ')
  };
}

export function normalizeKzPhone(value) {
  let digits = clean(value).replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.substring(1);
  }

  if (digits.length === 10 && digits.startsWith('7')) {
    digits = '7' + digits;
  }

  if (!/^77\d{9}$/.test(digits)) {
    fail('Телефон должен быть мобильным номером РК в формате +7 7XX XXX XX XX.');
  }

  return (
    '+7 ' +
    digits.substring(1, 4) + ' ' +
    digits.substring(4, 7) + ' ' +
    digits.substring(7, 9) + ' ' +
    digits.substring(9, 11)
  );
}

export function validateEmail(value) {
  const email = clean(value);

  if (!email) {
    return '';
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail('Некорректный email.');
  }

  return email.toLowerCase();
}

export function normalizeTelegram(value) {
  const raw = clean(value);

  if (!raw) {
    return { display: '', url: '' };
  }

  if (/^https?:\/\//i.test(raw)) {
    return { display: raw, url: raw };
  }

  const username = raw
    .replace(/^@/, '')
    .replace(/^t\.me\//i, '')
    .trim();

  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    fail('Telegram должен быть ссылкой или username длиной 5–32 символа.');
  }

  return {
    display: '@' + username,
    url: 'https://t.me/' + username
  };
}

export function validateHttpUrl(value) {
  const url = clean(value);

  if (!url) {
    return '';
  }

  if (!/^https?:\/\//i.test(url)) {
    fail('Ссылка должна начинаться с http:// или https://');
  }

  return url;
}

export function normalizeProfileUrl(value, type) {
  const raw = clean(value);

  if (!raw) {
    return '';
  }

  if (/^https?:\/\//i.test(raw)) {
    return validateHttpUrl(raw);
  }

  if (type === 'github') {
    const handle = raw
      .replace(/^@/, '')
      .replace(/^(?:www\.)?github\.com\//i, '')
      .replace(/^\/+/, '');

    return validateHttpUrl('https://github.com/' + handle);
  }

  if (type === 'linkedin') {
    const handle = raw
      .replace(/^@/, '')
      .replace(/^(?:www\.)?linkedin\.com\//i, '')
      .replace(/^\/+/, '');

    return validateHttpUrl(
      'https://www.linkedin.com/' + (handle.startsWith('in/') ? handle : 'in/' + handle)
    );
  }

  return validateHttpUrl(raw);
}

// Возвращает null для пустого значения, иначе целое неотрицательное число.
export function normalizeMoney(value) {
  const raw = clean(value).replace(/\s/g, '').replace(/,/g, '.');

  if (!raw) {
    return null;
  }

  const number = Number(raw);

  if (!Number.isFinite(number) || number < 0) {
    fail('Некорректное денежное значение.');
  }

  return Math.round(number);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(clean(value));
}

// Пустое значение → null; невалидный UUID → ошибка «не найдено».
export function optionalUuid(value, notFoundMessage) {
  const id = clean(value);

  if (!id) {
    return null;
  }

  if (!isUuid(id)) {
    fail(notFoundMessage, 404);
  }

  return id;
}

export function toBoolean(value) {
  return value === true || clean(value).toLowerCase() === 'true';
}
