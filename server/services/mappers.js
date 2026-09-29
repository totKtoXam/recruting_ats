// Преобразование строк PostgreSQL в DTO с ключами, которые UI исторически
// получал из Google Sheets. Контракт фронтенда при этом не меняется.
import { formatDateTime } from '../lib/dates.js';
import { composeFullName } from '../lib/validation.js';

import { APP_CONFIG, withBase } from '../config.js';

// Состояние записи: активная, в архиве или в корзине (с датой окончательного удаления).
export function lifecycleFields(row) {
  const deletedAt = row.deleted_at ? new Date(row.deleted_at) : null;
  const retention = APP_CONFIG.TRASH_RETENTION_DAYS * 86_400_000;
  const purgeAt = deletedAt ? new Date(deletedAt.getTime() + retention) : null;

  return {
    state: row.deleted_at ? 'deleted' : row.archived_at ? 'archived' : 'active',
    archivedAt: formatDateTime(row.archived_at),
    deletedAt: formatDateTime(row.deleted_at),
    purgeAt: formatDateTime(purgeAt),
    daysUntilPurge: purgeAt ? Math.max(0, Math.ceil((purgeAt.getTime() - Date.now()) / 86_400_000)) : null
  };
}

export const fileUrl = fileId => (fileId ? withBase(`/files/${fileId}`) : '');
export const candidateFolderUrl = candidateId => withBase(`/candidates/${candidateId}/files`);

function softDeleteFields(row) {
  return {
    'Дата создания': formatDateTime(row.created_at),
    'Дата изменения': formatDateTime(row.updated_at),
    ...lifecycleFields(row)
  };
}

export function toVacancy(row) {
  return {
    'Vacancy ID': row.id,
    '№': row.number,
    'Вакансия': row.name,
    'Статус': row.status,
    links: Array.isArray(row.links) ? row.links : [],
    ...softDeleteFields(row)
  };
}

export function toSource(row) {
  return {
    'Source ID': row.id,
    '№': row.number,
    'Название': row.name,
    // Иконка: своя картинка важнее пресета; пустой ключ — определить по названию.
    iconKey: row.icon_key || '',
    iconUrl: row.icon_png ? withBase('/source-icons/') + `${row.id}?v=${row.icon_updated_at ? new Date(row.icon_updated_at).getTime() : 0}` : '',
    ...softDeleteFields(row)
  };
}

// Ответственный — пользователь с этапами; 'Responsible ID' совпадает с 'User ID'.
export function toResponsible(row) {
  const stages = row.stages || [];

  return {
    'Responsible ID': row.id,
    'User ID': row.id,
    'Фамилия': row.last_name,
    'Имя': row.first_name,
    'Отчество': row.middle_name,
    'ФИО': userDisplayName(row),
    'Email': row.email,
    'Доступные этапы': JSON.stringify(stages),
    stages,
    hasAccess: Boolean(row.is_active)
  };
}

export function userDisplayName(row) {
  return composeFullName(row.last_name, row.first_name, row.middle_name) || row.full_name || row.email || '';
}

// Вопрос шаблона: { text, answers } — текст и список вероятных ответов.
// Старый формат (строка) приводится к объекту.
export function normalizeTemplateQuestions(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map(question => {
      const item = typeof question === 'string' ? { text: question } : question || {};
      const text = String(item.text ?? '').trim();
      const answers = [
        ...new Set(
          (Array.isArray(item.answers) ? item.answers : [])
            .map(answer => String(answer ?? '').trim())
            .filter(Boolean)
        )
      ];
      return { text, answers };
    })
    .filter(question => question.text);
}

// Теги шаблона: [{ name, color }]; цвет — ключ палитры, неизвестный заменяется серым.
export const TEMPLATE_TAG_COLORS = Object.freeze(['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'gray']);
const MAX_TEMPLATE_TAGS = 10;

export function normalizeTemplateTags(tags) {
  const seen = new Set();
  const result = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    const name = String((tag && tag.name) ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const color = TEMPLATE_TAG_COLORS.includes(tag.color) ? tag.color : 'gray';
    result.push({ name, color });
  }
  return result.slice(0, MAX_TEMPLATE_TAGS);
}

export function toTemplate(row) {
  const questions = normalizeTemplateQuestions(row.questions);

  return {
    'Template ID': row.id,
    '№': row.number,
    'Название': row.name,
    'Вопросы': JSON.stringify(questions),
    questions,
    tags: normalizeTemplateTags(row.tags),
    // Сколько вакансий используют шаблон (для списка шаблонов).
    usage: row.usage === undefined ? undefined : Number(row.usage),
    // Привязка к вакансии и этапу — только когда шаблон выбран для конкретной вакансии.
    ...(row.stage === undefined
      ? {}
      : { 'Vacancy ID': row.vacancy_id, 'Этап': row.stage, 'Обязательный': row.required, required: row.required }),
    ...softDeleteFields(row)
  };
}

export function toPublicUser(row) {
  return {
    'User ID': row.id,
    'Email': row.email,
    'ФИО': userDisplayName(row),
    'Фамилия': row.last_name || '',
    'Имя': row.first_name || '',
    'Отчество': row.middle_name || '',
    stages: row.stages || [],
    telegram: row.telegram_username ? '@' + row.telegram_username : '',
    // Подтверждён — привязан через бота (есть chat_id), иначе ник указан вручную.
    telegramVerified: Boolean(row.telegram_chat_id),
    // Email ещё не входил ни разу — его можно исправить (например, временный адрес).
    emailEditable: !row.google_subject,
    ...lifecycleFields(row),
    'Avatar URL': row.avatar_url,
    'IsActive': row.is_active,
    isAdmin: Boolean(row.is_admin),
    accessStatus: userAccessStatus(row),
    'Статус доступа': USER_ACCESS_LABELS[userAccessStatus(row)],
    'Последний вход': formatDateTime(row.last_login_at),
    'Доступ выдан': formatDateTime(row.access_granted_at),
    'Запрос доступа': formatDateTime(row.access_requested_at),
    'Добавлен': formatDateTime(row.created_at)
  };
}

export const USER_ACCESS_LABELS = {
  active: 'Доступ открыт',
  pending: 'Ожидает доступа',
  disabled: 'Доступ отключён'
};

// pending — доступ ещё ни разу не выдавался; disabled — был выдан и отозван.
export function userAccessStatus(row) {
  if (row.is_active) return 'active';
  return row.access_granted_at ? 'disabled' : 'pending';
}

export function toResumeVersion(row) {
  return {
    id: row.file_id,
    url: row.external_url || fileUrl(row.file_id),
    name: row.original_name,
    uploadedAt: formatDateTime(row.uploaded_at)
  };
}

function rejectedByLabel(row) {
  if (!row.rejected_at) return '';
  if (row.rejected_by_type === 'candidate') return 'Кандидат';
  return row.rejected_by_responsible_name || '';
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
    'Ответственный проф. интервьювер': row.tech_interviewer_name || '',
    'Резюме': latestResumeUrl,
    'Resume File ID': row.latest_resume_file_id || '',
    'Папка кандидата': candidateFolderUrl(row.id),
    'Дата добавления': formatDateTime(row.created_at),
    'Дата изменения': formatDateTime(row.updated_at),
    'Архивирован': archived,
    'Дата архивации': formatDateTime(row.archived_at),
    ...lifecycleFields(row),
    'Причина отказа': row.rejection_reason,
    'Комментарий к отказу': row.rejection_comment || '',
    'Кем отказано': rejectedByLabel(row),
    'Дата отказа': formatDateTime(row.rejected_at),
    rejection: row.rejected_at
      ? {
          fromStatus: row.rejected_from_status || '',
          byType: row.rejected_by_type || '',
          byResponsibleId: row.rejected_by_responsible_id || '',
          reason: row.rejection_reason || '',
          comment: row.rejection_comment || ''
        }
      : null,
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
    details: row.details || null,
    'Дата': formatDateTime(row.created_at)
  };
}
