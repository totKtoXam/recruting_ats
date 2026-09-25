// Получение GOOGLE_DRIVE_REFRESH_TOKEN для режима GOOGLE_DRIVE_AUTH=oauth.
//
//   1. В OAuth-клиенте Google Cloud должен быть Authorized redirect URI:
//        http://localhost:53682/oauth2callback (по умолчанию)
//      Можно использовать уже зарегистрированный адрес входа в приложение —
//      тогда остановите сервер ATS и укажите его явно:
//        DRIVE_AUTH_REDIRECT_URI=http://localhost:3000/auth/google/callback
//   2. npm run drive:auth
//   3. Откройте ссылку, войдите аккаунтом-владельцем папки «Кандидаты» и разрешите доступ.
//   4. Скопируйте выведенный refresh token в .env.
//
// Приложение будет работать с Drive от имени этого аккаунта (как Apps Script
// с «Execute as: Me»). Файлы резюме занимают квоту этого аккаунта.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { auth } from '@googleapis/drive';
import { config } from '../server/config.js';

const REDIRECT_URI = process.env.DRIVE_AUTH_REDIRECT_URI || 'http://localhost:53682/oauth2callback';
const redirect = new URL(REDIRECT_URI);

if (!['localhost', '127.0.0.1'].includes(redirect.hostname)) {
  console.error('DRIVE_AUTH_REDIRECT_URI должен указывать на localhost.');
  process.exit(1);
}

const { clientId, clientSecret } = config.drive;

if (!clientId || !clientSecret) {
  console.error('Задайте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET (или GOOGLE_DRIVE_CLIENT_ID/SECRET) в .env.');
  process.exit(1);
}

const client = new auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
const state = randomBytes(16).toString('hex');

const url = client.generateAuthUrl({
  access_type: 'offline',
  // consent гарантирует выдачу refresh token даже при повторной авторизации.
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
  state
});

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, REDIRECT_URI);

  if (requestUrl.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }

  // Чужой state (старая ссылка, повторный заход) не завершает скрипт — ждём корректный ответ.
  if (requestUrl.searchParams.get('state') !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ссылка устарела. Откройте ссылку, которую сейчас показывает терминал.');
    console.error('Получен ответ по устаревшей ссылке — ожидаю ответ по актуальной.');
    return;
  }

  try {
    const error = requestUrl.searchParams.get('error');
    if (error) {
      throw new Error(`Google вернул ошибку: ${error}`);
    }

    const { tokens } = await client.getToken(requestUrl.searchParams.get('code'));

    if (!tokens.refresh_token) {
      throw new Error('Refresh token не получен. Отзовите доступ приложения в https://myaccount.google.com/permissions и повторите.');
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Готово. Вернитесь в терминал.');

    console.log('\nДобавьте в .env:\n');
    console.log(`GOOGLE_DRIVE_AUTH=oauth`);
    console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    server.close();
  } catch (error) {
    // Причину (например, настройки OAuth-клиента) можно исправить и открыть ссылку ещё раз.
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error.message + '\n\nИсправьте причину и откройте ссылку из терминала ещё раз.');
    console.error(error.message + ' — ожидаю повторную попытку.');
  }
});

server.listen(Number(redirect.port) || 80, 'localhost', () => {
  console.log('Откройте в браузере и войдите аккаунтом-владельцем папки с резюме:\n');
  console.log(url + '\n');
});
