// Перенос данных из прежней Google-таблицы Recruiting ATS в PostgreSQL.
//
//   1. Google Sheets → Файл → Скачать → Microsoft Excel (.xlsx)
//   2. npm run migrate
//   3. npm run import:sheets -- ./recruiting-ats.xlsx
//
// Файлы не копируются: резюме и папки кандидатов уже лежат в Google Drive,
// импортируются их Drive ID. Аккаунт, от имени которого работает приложение,
// должен иметь доступ к старой папке «Кандидаты» (лучше указать её же в GOOGLE_DRIVE_ROOT_FOLDER_ID).
// Импорт выполняется одной транзакцией и только в пустую базу.
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { APP_CONFIG, config } from '../server/config.js';
import { pool, transaction } from '../server/db/pool.js';
import { isUuid, splitFullName } from '../server/lib/validation.js';

const SHEETS = {
  users: 'Пользователи',
  vacancies: 'Вакансии',
  sources: 'Источники',
  responsibles: 'Ответственные',
  templates: 'Шаблоны интервью',
  candidates: 'Кандидаты',
  archived: 'Архив кандидатов',
  interviews: 'Интервью',
  log: 'Candidate Transition Status Log',
  dicts: 'Справочники'
};

// ---------- Чтение xlsx ----------

function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('result' in value) return cellValue(value.result);
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('text' in value) return String(value.text);
    if ('hyperlink' in value) return String(value.hyperlink);
    return '';
  }
  return value;
}

function readSheet(workbook, name) {
  const sheet = workbook.getWorksheet(name);

  if (!sheet) {
    console.warn(`Лист "${name}" не найден — пропущен.`);
    return [];
  }

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cellValue(cell.value)).trim();
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = {};
    let filled = false;
    headers.forEach((header, col) => {
      if (!header) return;
      const value = cellValue(row.getCell(col).value);
      item[header] = value;
      if (String(value).trim() !== '') filled = true;
    });
    if (filled) rows.push(item);
  });

  return rows;
}

// ---------- Преобразования ----------

const str = value => (value instanceof Date ? value.toISOString() : String(value ?? '').trim());
const bool = value => value === true || str(value).toLowerCase() === 'true';
const num = value => {
  const n = Number(str(value).replace(/\s/g, ''));
  return str(value) && Number.isFinite(n) ? Math.round(n) : null;
};
const json = (value, fallback) => {
  try {
    return str(value) ? JSON.parse(str(value)) : fallback;
  } catch {
    return fallback;
  }
};

// ID файла/папки Drive из ссылки вида .../file/d/<id>/..., .../folders/<id> или ?id=<id>.
function driveId(value) {
  const text = str(value);
  const match = text.match(/\/(?:file\/d|folders)\/([A-Za-z0-9_-]{10,})/) || text.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return match ? match[1] : '';
}

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const mimeFor = name => MIME_BY_EXTENSION[str(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

const httpUrl = value => (/^https?:\/\//i.test(str(value)) ? str(value) : '');

// Смещение часового пояса приложения (мс) для момента instant.
function tzOffset(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(instant)).map(p => [p.type, p.value])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// Даты в таблице записаны как локальное время APP_TIMEZONE ("yyyy-MM-dd HH:mm:ss")
// или как ISO-строки (черновики). Excel-даты exceljs отдаёт как UTC-представление wall-clock.
function date(value) {
  if (value instanceof Date) {
    const wall = value.getTime();
    return new Date(wall - tzOffset(wall));
  }

  const text = str(value);
  if (!text) return null;

  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const wall = Date.UTC(match[1], match[2] - 1, match[3], match[4], match[5], match[6] || 0);
    return new Date(wall - tzOffset(wall));
  }

  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function nameParts(row, full, last = 'Фамилия', first = 'Имя', middle = 'Отчество') {
  const fallback = splitFullName(row[full]);
  return {
    last: str(row[last]) || fallback.lastName,
    first: str(row[first]) || fallback.firstName,
    middle: str(row[middle]) || fallback.middleName
  };
}

// Сохраняет исходные номера; пустые и повторяющиеся получают следующий свободный.
function numberer(rows) {
  let max = rows.reduce((result, row) => Math.max(result, num(row['№']) || 0), 0);
  const used = new Set();
  return row => {
    let value = num(row['№']);
    if (!value || value < 1 || used.has(value)) value = ++max;
    used.add(value);
    return value;
  };
}

// Сохраняем исходные UUID; невалидные ID заменяются новыми.
function idMap() {
  const map = new Map();
  return {
    take(oldId) {
      const key = str(oldId);
      const id = isUuid(key) ? key : randomUUID();
      if (key) map.set(key, id);
      return id;
    },
    alias(oldId, id) {
      if (str(oldId)) map.set(str(oldId), id);
    },
    get: oldId => map.get(str(oldId)) || null
  };
}

// Новая нумерация продолжится после максимального импортированного номера.
async function syncNumberSequences(tx) {
  for (const table of ['vacancies', 'sources', 'responsibles', 'interview_templates', 'candidates']) {
    await tx.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'number'),
                     COALESCE((SELECT max(number) FROM ${table}), 0) + 1, false)`
    );
  }
}

// ---------- Импорт ----------

async function main() {
  const file = process.argv[2];

  if (!file) {
    console.error('Использование: npm run import:sheets -- <path-to.xlsx>');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  const data = Object.fromEntries(
    Object.entries(SHEETS).map(([key, name]) => [key, readSheet(workbook, name)])
  );

  const ids = {
    users: idMap(), vacancies: idMap(), sources: idMap(),
    responsibles: idMap(), templates: idMap(), candidates: idMap()
  };
  const stats = {};

  await transaction(async tx => {
    // Пользователи могли уже войти до импорта, поэтому проверяются только бизнес-данные.
    const { count } = await tx.one(
      `SELECT (SELECT count(*) FROM candidates) + (SELECT count(*) FROM vacancies)
            + (SELECT count(*) FROM responsibles) + (SELECT count(*) FROM sources)
            + (SELECT count(*) FROM interview_templates) AS count`
    );
    if (Number(count) > 0) {
      throw new Error('База уже содержит данные ATS. Импорт выполняется только в пустую базу.');
    }

    for (const row of data.users) {
      const email = str(row.Email).toLowerCase();
      if (!email) continue;
      const subject = str(row['Google Subject']);
      const existingUser = await tx.one('SELECT id FROM users WHERE lower(email) = $1', [email]);
      if (existingUser) {
        // Пользователь уже входил в новую систему — связываем старый User ID с текущей записью.
        ids.users.alias(row['User ID'], existingUser.id);
        continue;
      }
      await tx.query(
        `INSERT INTO users (id, google_subject, email, full_name, avatar_url, is_active, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8)`,
        [
          ids.users.take(row['User ID']),
          subject && !subject.startsWith('email:') ? subject : null,
          email, str(row['ФИО']), str(row['Avatar URL']),
          str(row.IsActive) === '' ? true : bool(row.IsActive),
          date(row['Дата создания']), date(row['Последний вход'])
        ]
      );
    }
    stats.users = data.users.length;

    const vacancyNumber = numberer(data.vacancies);
    for (const row of data.vacancies) {
      const status = APP_CONFIG.VACANCY_STATUSES.includes(str(row['Статус'])) ? str(row['Статус']) : 'Закрыта';
      await tx.query(
        `INSERT INTO vacancies (id, number, name, status, comment, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), COALESCE($7, now()), $8)`,
        [
          ids.vacancies.take(row['Vacancy ID']), vacancyNumber(row), str(row['Вакансия']) || 'Без названия',
          status, str(row['Комментарий']), date(row['Дата создания']), date(row['Дата изменения']),
          bool(row['Удален']) ? date(row['Дата удаления']) || new Date() : null
        ]
      );
    }

    const sourceNumber = numberer(data.sources);
    for (const row of data.sources) {
      await tx.query(
        `INSERT INTO sources (id, number, name, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, COALESCE($4, now()), COALESCE($5, now()), $6)`,
        [
          ids.sources.take(row['Source ID']), sourceNumber(row), str(row['Название']),
          date(row['Дата создания']), date(row['Дата изменения']),
          bool(row['Удален']) ? date(row['Дата удаления']) || new Date() : null
        ]
      );
    }

    const responsibleNumber = numberer(data.responsibles);
    for (const row of data.responsibles) {
      const name = nameParts(row, 'ФИО');
      await tx.query(
        `INSERT INTO responsibles (id, number, last_name, first_name, middle_name, email, user_id, stages,
                                   created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), COALESCE($10, now()), $11)`,
        [
          ids.responsibles.take(row['Responsible ID']), responsibleNumber(row), name.last || '—', name.first || '—',
          name.middle, str(row.Email).toLowerCase(), ids.users.get(row['User ID']),
          json(row['Доступные этапы'], []).filter(stage => APP_CONFIG.PIPELINE_STATUSES.includes(stage)),
          date(row['Дата создания']), date(row['Дата изменения']),
          bool(row['Удален']) ? date(row['Дата удаления']) || new Date() : null
        ]
      );
    }

    const templateNumber = numberer(data.templates);
    for (const row of data.templates) {
      const vacancyId = ids.vacancies.get(row['Vacancy ID']);
      if (!vacancyId) continue;
      await tx.query(
        `INSERT INTO interview_templates (id, number, name, vacancy_id, stage, required, questions,
                                          created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), COALESCE($9, now()), $10)`,
        [
          ids.templates.take(row['Template ID']), templateNumber(row), str(row['Название']), vacancyId,
          str(row['Этап']), bool(row['Обязательный']), JSON.stringify(json(row['Вопросы'], [])),
          date(row['Дата создания']), date(row['Дата изменения']),
          bool(row['Удален']) ? date(row['Дата удаления']) || new Date() : null
        ]
      );
    }

    await syncNumberSequences(tx);

    // Заглушки для старых записей без обязательных связей.
    let placeholderResponsible = null;
    let placeholderVacancy = null;

    const fallbackResponsible = async () => {
      placeholderResponsible ||= (await tx.one(
        `INSERT INTO responsibles (last_name, first_name, stages, deleted_at)
         VALUES ('Импорт', 'Не назначен', $1, now()) RETURNING id`,
        [APP_CONFIG.PIPELINE_STATUSES]
      )).id;
      return placeholderResponsible;
    };

    const fallbackVacancy = async () => {
      placeholderVacancy ||= (await tx.one(
        `INSERT INTO vacancies (name, status, deleted_at)
         VALUES ('Без вакансии (импорт)', 'Закрыта', now()) RETURNING id`
      )).id;
      return placeholderVacancy;
    };

    const candidateRows = [
      ...data.candidates.map(row => ({ row, archived: false })),
      ...data.archived.map(row => ({ row, archived: true }))
    ];

    const importedDriveFiles = new Set();
    const candidateNumber = numberer(candidateRows.map(item => item.row));

    for (const { row, archived } of candidateRows) {
      if (!str(row.ID) || ids.candidates.get(row.ID)) continue;

      const id = ids.candidates.take(row.ID);
      const name = nameParts(row, 'ФИО');
      const recruiterId = ids.responsibles.get(row['Responsible ID']) || (await fallbackResponsible());
      const salary = num(row['Зарплатные ожидания']);

      await tx.query(
        `INSERT INTO candidates
           (id, number, last_name, first_name, middle_name, vacancy_id, status, phone, email,
            telegram, telegram_url, linkedin, github, source_id, salary_expectation,
            recruiter_id, hr_responsible_id, tech_interviewer_id, drive_folder_id,
            comment, links, rejection_reason, created_at, updated_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
                 $20, $21, $22, COALESCE($23, now()), COALESCE($24, $23, now()), $25)`,
        [
          id, candidateNumber(row), name.last || '—', name.first || '—', name.middle,
          ids.vacancies.get(row['Vacancy ID']) || (await fallbackVacancy()),
          str(row['Статус']) || 'Новый', str(row['Телефон']), str(row.Email).toLowerCase(),
          str(row.Telegram), str(row['Telegram URL']), str(row.LinkedIn), str(row.GitHub),
          ids.sources.get(row['Source ID']),
          salary !== null && salary >= 0 && salary <= 10_000_000 ? salary : null,
          recruiterId,
          ids.responsibles.get(row['HR Responsible ID']) || recruiterId,
          ids.responsibles.get(row['Tech Interviewer ID']) || recruiterId,
          driveId(row['Папка кандидата']) || null, str(row['Комментарий']),
          JSON.stringify(json(row['Иные ссылки'], [])), str(row['Причина отказа']),
          date(row['Дата добавления']), date(row['Дата изменения']),
          archived || bool(row['Архивирован']) ? date(row['Дата архивации']) || new Date() : null
        ]
      );

      let versions = json(row['Версии резюме'], []);
      if (!versions.length && str(row['Резюме'])) {
        versions = [{
          id: row['Resume File ID'], url: str(row['Резюме']), name: 'Резюме', uploadedAt: row['Дата добавления']
        }];
      }

      for (const version of versions.filter(Boolean)) {
        const fileId = str(version.id) || driveId(version.url);
        const url = httpUrl(version.url);
        const name = str(version.name) || 'Резюме';

        // Один и тот же файл Drive регистрируется один раз; без Drive ID остаётся внешняя ссылка.
        const useDrive = fileId && !importedDriveFiles.has(fileId);
        if (!useDrive && !url) continue;
        if (useDrive) importedDriveFiles.add(fileId);

        const file = await tx.one(
          `INSERT INTO files (drive_file_id, external_url, original_name, mime_type)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [useDrive ? fileId : null, useDrive ? null : url, name, mimeFor(name)]
        );
        await tx.query(
          `INSERT INTO candidate_resumes (candidate_id, file_id, uploaded_at)
           VALUES ($1, $2, COALESCE($3, now()))`,
          [id, file.id, date(version.uploadedAt)]
        );
      }
    }
    stats.candidates = candidateRows.length;

    let interviews = 0;
    for (const row of data.interviews) {
      const candidateId = ids.candidates.get(row['Candidate ID']);
      if (!candidateId) continue;
      const interviewer = nameParts(row, 'Интервьюер', 'Фамилия интервьюера', 'Имя интервьюера', 'Отчество интервьюера');
      const candidate = await tx.one('SELECT vacancy_id FROM candidates WHERE id = $1', [candidateId]);
      await tx.query(
        `INSERT INTO interviews
           (id, candidate_id, vacancy_id, stage, from_status, to_status, template_id, template_name,
            responsible_id, interviewer_last_name, interviewer_first_name, interviewer_middle_name,
            answers, comment, result, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 COALESCE($16, now()), COALESCE($17, $16, now()), $18)`,
        [
          isUuid(str(row['Interview ID'])) ? str(row['Interview ID']) : randomUUID(),
          candidateId, ids.vacancies.get(row['Vacancy ID']) || candidate.vacancy_id,
          str(row['Этап']) || str(row['From Status']), str(row['From Status']) || str(row['Этап']),
          str(row['To Status']), ids.templates.get(row['Template ID']), str(row['Шаблон']),
          ids.responsibles.get(row['Responsible ID']), interviewer.last, interviewer.first, interviewer.middle,
          JSON.stringify(json(row['Вопросы и ответы'], [])), str(row['Комментарий']), str(row['Результат']),
          date(row['Дата']), date(row['Дата изменения']),
          bool(row['Удален']) ? date(row['Дата удаления']) || new Date() : null
        ]
      );
      interviews += 1;
    }
    stats.interviews = interviews;

    let logEntries = 0;
    for (const row of data.log) {
      const candidateId = ids.candidates.get(row['Candidate ID']);
      if (!candidateId || !str(row['To Status'])) continue;
      await tx.query(
        `INSERT INTO candidate_status_log
           (candidate_id, candidate_number, candidate_full_name, from_status, to_status, responsible_id,
            responsible_name, changed_by_user_id, changed_by_name, changed_by_email, comment, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, now()))`,
        [
          candidateId, num(row['№ кандидата']), str(row['ФИО']), str(row['From Status']), str(row['To Status']),
          ids.responsibles.get(row['Responsible ID']), str(row['Ответственный']),
          ids.users.get(row['Changed By User ID']), str(row['Changed By']), str(row['Changed By Email']),
          str(row['Комментарий']), date(row['Дата'])
        ]
      );
      logEntries += 1;
    }
    stats.transitionLog = logEntries;

    if (data.dicts.length) {
      await tx.query('DELETE FROM dictionaries');
      for (const category of Object.keys(data.dicts[0])) {
        const values = [...new Set(data.dicts.map(row => str(row[category])).filter(Boolean))];
        for (const [index, value] of values.entries()) {
          await tx.query(
            'INSERT INTO dictionaries (category, value, position) VALUES ($1, $2, $3)',
            [category, value, index + 1]
          );
        }
      }
    }

    await syncNumberSequences(tx);
  });

  console.log('Импорт завершён:', stats);
}

main()
  .catch(error => {
    console.error('Импорт не выполнен:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
