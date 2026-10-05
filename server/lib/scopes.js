// Доступ к отдельным данным (scope) поверх роли: выдаётся администратором в карточке
// пользователя («Настройки → Пользователи») и хранится в users.scopes.
// Права администратора scope не подразумевают — администратор выдаёт его явно, в том числе себе.
import { fail } from './errors.js';

export const SCOPES = [
  {
    key: 'salary',
    label: 'ЗП ожидания',
    description: 'Видит и меняет зарплатные ожидания кандидатов'
  }
];

export const SCOPE_KEYS = SCOPES.map(scope => scope.key);

export const hasScope = (user, scope) =>
  Boolean(user && user.is_active !== false && Array.isArray(user.scopes) && user.scopes.includes(scope));

export function requireScope(user, scope, message = 'Нет доступа.') {
  if (!hasScope(user, scope)) fail(message, 403);
}

// Список scope из формы: только известные ключи, в порядке каталога.
export function normalizeScopes(value) {
  const list = Array.isArray(value) ? value.map(String) : [];
  const invalid = list.filter(item => !SCOPE_KEYS.includes(item));
  if (invalid.length) fail('Неизвестный доступ: ' + invalid.join(', '));
  return SCOPE_KEYS.filter(key => list.includes(key));
}
