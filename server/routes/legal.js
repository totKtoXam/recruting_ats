// Публичные страницы без входа: Google требует ссылку на политику конфиденциальности
// для публикации OAuth-приложения (Google Auth Platform → Branding).
// Текст — шаблон; перед публикацией его должен проверить юрист компании.
import express from 'express';
import { config } from '../config.js';
import { escapeHtml } from './html.js';

function page(title, body) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Recruiting ATS</title>
<style>
  body{font-family:Inter,Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#172033;line-height:1.55;font-size:15px}
  h1{font-size:22px} h2{font-size:16px;margin-top:24px} a{color:#4f46e5}
  .muted{color:#6b7588;font-size:13px}
</style></head>
<body>${body}</body></html>`;
}

export function legalRouter() {
  const router = express.Router();
  const operator = escapeHtml(config.legal.operatorName);
  const contact = config.legal.contactEmail
    ? `<a href="mailto:${escapeHtml(config.legal.contactEmail)}">${escapeHtml(config.legal.contactEmail)}</a>`
    : 'администратору системы';

  router.get('/privacy', (_req, res) => {
    res.type('html').send(page('Политика конфиденциальности', `
  <h1>Политика конфиденциальности Recruiting ATS</h1>
  <p class="muted">Recruiting ATS — внутренняя система ${operator} для ведения подбора персонала.</p>

  <h2>Какие данные обрабатываются</h2>
  <p>При входе через Google система получает адрес электронной почты, имя и фото профиля пользователя.
  Они используются только для входа и отображения пользователя в системе.</p>
  <p>В системе хранятся данные кандидатов, которые вносят сотрудники: ФИО, контакты, резюме,
  результаты интервью и история этапов найма.</p>

  <h2>Google Drive</h2>
  <p>Файлы резюме хранятся в папке Google Drive организации. Система обращается к Google Drive
  только для загрузки, копирования, чтения и перемещения в корзину файлов резюме кандидатов.</p>

  <h2>Доступ и передача данных</h2>
  <p>Доступ к системе есть только у пользователей, которым его открыл администратор.
  Данные не продаются и не передаются третьим лицам, кроме случаев, предусмотренных законодательством.</p>

  <h2>Хранение и удаление</h2>
  <p>Данные хранятся, пока нужны для процесса найма. Чтобы уточнить, какие данные о вас хранятся,
  или запросить их удаление, напишите ${contact}.</p>
`));
  });

  return router;
}
