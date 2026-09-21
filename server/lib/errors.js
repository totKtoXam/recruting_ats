// Ошибка, текст которой можно показать пользователю.
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export function fail(message, status) {
  throw new AppError(message, status);
}

const PG_MESSAGES = {
  users_email_uq: 'Этот email уже закреплён за другим пользователем ATS. Обратитесь к администратору.',
  sources_name_active_uq: 'Источник с таким названием уже существует.',
  responsibles_user_active_uq: 'Этот пользователь уже привязан к другому ответственному.',
  interview_templates_required_uq: 'Для этой вакансии и этапа уже есть обязательный шаблон.'
};

// Переводит нарушения ограничений PostgreSQL в понятные сообщения.
export function toPublicError(error) {
  if (error instanceof AppError) {
    return error;
  }

  if (error && error.code === '23505' && PG_MESSAGES[error.constraint]) {
    return new AppError(PG_MESSAGES[error.constraint], 409);
  }

  if (error && error.code === '22P02') {
    return new AppError('Некорректный идентификатор.', 400);
  }

  return null;
}
