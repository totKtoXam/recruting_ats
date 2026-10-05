// ЗП ожидания кандидата хранится только в зашифрованном виде (candidates.salary_expectation_enc,
// AES-256-GCM, server/lib/secretbox.js) и доступна пользователям со scope «salary».
import { decryptSecret, encryptSecret } from './secretbox.js';
import { hasScope, requireScope } from './scopes.js';

const PURPOSE = 'candidate-salary';

export const SALARY_SCOPE = 'salary';
export const SALARY_DENIED_MESSAGE = 'Нет доступа к ЗП ожиданиям: его выдаёт администратор в «Настройки → Пользователи».';
// Показывается вместо суммы, если значение не расшифровалось (сменился ключ шифрования).
export const SALARY_UNREADABLE = 'не расшифровано';

export const canViewSalary = user => hasScope(user, SALARY_SCOPE);
export const requireSalaryAccess = user => requireScope(user, SALARY_SCOPE, SALARY_DENIED_MESSAGE);

export function encryptSalary(amount) {
  return amount === null || amount === undefined || amount === '' ? null : encryptSecret(String(amount), PURPOSE);
}

// null — не указана; undefined — не удалось расшифровать.
export function decryptSalary(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  const plain = decryptSecret(stored, PURPOSE);
  if (plain === null) return undefined;
  const amount = Number(plain);
  return Number.isFinite(amount) ? amount : undefined;
}

// Произвольный текст (подписи журнала изменений) тем же ключом.
export const encryptSalaryText = text => encryptSecret(String(text), PURPOSE);
export const decryptSalaryText = stored => decryptSecret(stored, PURPOSE);
