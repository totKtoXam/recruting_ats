// ЗП ожидания кандидатов: шифрование в БД и доступ по scope «salary».
//   - users.scopes — выданные администратором доступы; scope «salary» получают текущие
//     администраторы (до этой миграции ЗП видели все, кто работает в ATS);
//   - candidates.salary_expectation (bigint) -> salary_expectation_enc (AES-256-GCM);
//   - журнал изменений поля «ЗП ожидания»: значения и подписи тоже шифруются;
//   - черновики кандидатов: data.salary -> data.salaryEnc.
import { encryptSalary, encryptSalaryText } from '../../lib/salary.js';

export default async function up(client) {
  await client.query(`ALTER TABLE users ADD COLUMN scopes text[] NOT NULL DEFAULT '{}'`);
  await client.query(`UPDATE users SET scopes = ARRAY['salary'] WHERE is_admin`);

  await client.query('ALTER TABLE candidates ADD COLUMN salary_expectation_enc text');
  const candidates = await client.query(
    'SELECT id, salary_expectation FROM candidates WHERE salary_expectation IS NOT NULL'
  );
  for (const row of candidates.rows) {
    await client.query('UPDATE candidates SET salary_expectation_enc = $2 WHERE id = $1', [
      row.id,
      encryptSalary(row.salary_expectation)
    ]);
  }
  await client.query('ALTER TABLE candidates DROP COLUMN salary_expectation');

  const encValue = value => {
    if (value === null || value === undefined) return null;
    return JSON.stringify({ salary_expectation_enc: encryptSalary(value.salary_expectation ?? null) });
  };
  const audit = await client.query(
    `SELECT id, old_value, new_value, old_display, new_display FROM audit_log
     WHERE entity_type = 'candidate' AND field = 'salary_expectation'`
  );
  for (const row of audit.rows) {
    await client.query(
      `UPDATE audit_log SET old_value = $2, new_value = $3, old_display = $4, new_display = $5 WHERE id = $1`,
      [
        row.id,
        encValue(row.old_value),
        encValue(row.new_value),
        row.old_display ? encryptSalaryText(row.old_display) : '',
        row.new_display ? encryptSalaryText(row.new_display) : ''
      ]
    );
  }

  const drafts = await client.query(`SELECT id, data FROM candidate_drafts WHERE data ? 'salary'`);
  for (const row of drafts.rows) {
    const { salary, ...data } = row.data;
    if (salary) data.salaryEnc = encryptSalaryText(salary);
    await client.query('UPDATE candidate_drafts SET data = $2 WHERE id = $1', [row.id, JSON.stringify(data)]);
  }
}
