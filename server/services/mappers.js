// Преобразование строк PostgreSQL в DTO с ключами, которые UI исторически
// получал из Google Sheets. Контракт фронтенда при этом не меняется.
import { formatDateTime } from '../lib/dates.js';
import { composeFullName } from '../lib/validation.js';

export const fileUrl = fileId => (fileId ? `/files/${fileId}` : '');
export const candidateFolderUrl = candidateId => `/candidates/${candidateId}/files`;

function softDeleteFields(row) {
  return {
    'Дата создания': formatDateTime(row.created_at),
    'Дата изменения': formatDateTime(row.updated_at),
    'Удален': Boolean(row.deleted_at),
    'Дата удаления': formatDateTime(row.deleted_at)
  };
}

export function toVacancy(row) {
  return {
    'Vacancy ID': row.id,
    '№': row.number,
    'Вакансия': row.name,
    'Статус': row.status,
    'Комментарий': row.comment,
    ...softDeleteFields(row)
  };
}

export function toSource(row) {
  return {
    'Source ID': row.id,
    '№': row.number,
    'Название': row.name,
    ...softDeleteFields(row)
  };
}

export function toResponsible(row) {
  const stages = row.stages || [];

  return {
    'Responsible ID': row.id,
    '№': row.number,
    'Фамилия': row.last_name,
    'Имя': row.first_name,
    'Отчество': row.middle_name,
    'ФИО': composeFullName(row.last_name, row.first_name, row.middle_name),
    'Email': row.email,
    'User ID': row.user_id || '',
    'Доступные этапы': JSON.stringify(stages),
    stages,
    ...softDeleteFields(row)
  };
}

export function toTemplate(row) {
  return {
    'Template ID': row.id,
    '№': row.number,
    'Название': row.name,
    'Vacancy ID': row.vacancy_id,
    'Вакансия': row.vacancy_name || '',
    'Этап': row.stage,
    'Обязательный': row.required,
    'Вопросы': JSON.stringify(row.questions || []),
    required: row.required,
    questions: row.questions || [],
    ...softDeleteFields(row)
  };
}

export function toPublicUser(row) {
  return {
    'User ID': row.id,
    'Email': row.email,
    'ФИО': row.full_name,
    'Avatar URL': row.avatar_url,
    'IsActive': row.is_active,
    'Последний вход': formatDateTime(row.last_login_at)
  };
}

export function toResumeVersion(row) {
  return {
    id: row.file_id,
    url: row.external_url || fileUrl(row.file_id),
    name: row.original_name,
    uploadedAt: formatDateTime(row.uploaded_at)
  };
}

// row — результат CANDIDATE_SELECT; resumeVersions передаются только для полной карточки.
export function toCandidate(row, resumeVersions) {
  const fullName = composeFullName(row.last_name, row.first_name, row.middle_name);
  const archived = Boolean(row.archived_at);
  const latestResumeUrl = row.latest_resume_external_url || fileUrl(row.latest_resume_file_id);

  const candidate = {
    'ID': row.id,
    '№': row.number,
    'Фамилия': row.last_name,
    'Имя': row.first_name,
    'Отчество': row.middle_name,
    'ФИО': fullName,
    'Vacancy ID': row.vacancy_id,
    'Vacancy №': row.vacancy_number,
    'Вакансия': row.vacancy_name,
    'Статус': row.status,
    'Телефон': row.phone,
    'Email': row.email,
    'Telegram': row.telegram,
    'Telegram URL': row.telegram_url,
    'LinkedIn': row.linkedin,
    'GitHub': row.github,
    'Source ID': row.source_id || '',
    'Источник': row.source_name || '',
    'Зарплатные ожидания': row.salary_expectation ?? '',
    'Responsible ID': row.recruiter_id,
    'Ответственный': row.recruiter_name || '',
    'HR Responsible ID': row.hr_responsible_id,
    'Ответственный HR': row.hr_responsible_name || '',
    'Tech Interviewer ID': row.tech_interviewer_id,
    'Ответственный тех. интервьювер': row.tech_interviewer_name || '',
    'Резюме': latestResumeUrl,
    'Resume File ID': row.latest_resume_file_id || '',
    'Папка кандидата': candidateFolderUrl(row.id),
    'Комментарий': row.comment,
    'Дата добавления': formatDateTime(row.created_at),
    'Дата изменения': formatDateTime(row.updated_at),
    'Архивирован': archived,
    'Дата архивации': formatDateTime(row.archived_at),
    'Причина отказа': row.rejection_reason,
    archived
  };

  if (resumeVersions) {
    candidate.links = row.links || [];
    candidate.resumeVersions = resumeVersions;
    candidate['Иные ссылки'] = JSON.stringify(candidate.links);
    candidate['Версии резюме'] = JSON.stringify(resumeVersions);
  }

  return candidate;
}

export function toInterview(row) {
  const answers = row.answers || [];

  return {
    'Interview ID': row.id,
    'Candidate ID': row.candidate_id,
    'Фамилия кандидата': row.candidate_last_name || '',
    'Имя кандидата': row.candidate_first_name || '',
    'Отчество кандидата': row.candidate_middle_name || '',
    'ФИО': composeFullName(
      row.candidate_last_name,
      row.candidate_first_name,
      row.candidate_middle_name
    ),
    'Vacancy ID': row.vacancy_id,
    'Вакансия': row.vacancy_name || '',
    'Этап': row.stage,
    'From Status': row.from_status,
    'To Status': row.to_status,
    'Template ID': row.template_id || '',
    'Шаблон': row.template_name,
    'Дата': formatDateTime(row.created_at),
    'Фамилия интервьюера': row.interviewer_last_name,
    'Имя интервьюера': row.interviewer_first_name,
    'Отчество интервьюера': row.interviewer_middle_name,
    'Интервьюер': composeFullName(
      row.interviewer_last_name,
      row.interviewer_first_name,
      row.interviewer_middle_name
    ),
    'Responsible ID': row.responsible_id || '',
    'Вопросы и ответы': JSON.stringify(answers),
    'Комментарий': row.comment,
    'Результат': row.result,
    answers,
    ...softDeleteFields(row)
  };
}

export function toTransitionLogEntry(row) {
  return {
    'Transition ID': row.id,
    'Candidate ID': row.candidate_id,
    '№ кандидата': row.candidate_number ?? '',
    'ФИО': row.candidate_full_name,
    'From Status': row.from_status,
    'To Status': row.to_status,
    'Responsible ID': row.responsible_id || '',
    'Ответственный': row.responsible_name,
    'Changed By User ID': row.changed_by_user_id || '',
    'Changed By': row.changed_by_name,
    'Changed By Email': row.changed_by_email,
    'Комментарий': row.comment,
    'Дата': formatDateTime(row.created_at)
  };
}
