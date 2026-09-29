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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'%3E%3Cdefs%3E%3ClinearGradient id='atsLogoG' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%2310b981'/%3E%3Cstop offset='1' stop-color='%23047857'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='72' height='72' rx='20' fill='url(%23atsLogoG)'/%3E%3Ccircle cx='31' cy='31' r='14' fill='none' stroke='%23fff' stroke-width='5'/%3E%3Cpath d='M41.5 41.5L55 55' stroke='%23fff' stroke-width='6' stroke-linecap='round'/%3E%3Ccircle cx='31' cy='27' r='4' fill='%23fff'/%3E%3Cpath d='M23 38c1-5 5-6 8-6s7 1 8 6z' fill='%23fff'/%3E%3C/svg%3E">
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
