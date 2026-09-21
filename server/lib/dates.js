import { config } from '../config.js';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

// Формат, который UI получал из Google Sheets: "yyyy-MM-dd HH:mm:ss" в TZ приложения.
export function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(part => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function isoOrEmpty(value) {
  return value ? new Date(value).toISOString() : '';
}
