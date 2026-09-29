import pg from 'pg';
import { config } from '../config.js';

// Realtime доски: Postgres LISTEN/NOTIFY -> SSE. Триггеры в БД (миграция 009) шлют id изменённого
// кандидата, браузер сам перечитывает карточку. Так события приходят и от других инстансов,
// и от скриптов, пишущих в БД напрямую.
const CHANNEL = 'ats_candidate';
const HEARTBEAT_MS = 25_000;
const RECONNECT_MS = 3_000;

const clients = new Set();
let listener = null;
let stopped = false;
let reconnectTimer = null;

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of clients) {
    res.write(frame);
  }
}

async function connect() {
  if (stopped) return;

  const client = new pg.Client({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined
  });
  listener = client;

  const reconnect = () => {
    if (listener !== client) return;
    listener = null;
    client.removeAllListeners();
    client.end().catch(() => {});
    if (!stopped) {
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
      reconnectTimer.unref();
    }
  };

  client.on('error', reconnect);
  client.on('end', reconnect);
  client.on('notification', message => {
    if (message.channel === CHANNEL && message.payload) broadcast('candidate', message.payload);
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    // Браузеры могли пропустить события за время обрыва — пусть перечитают доску.
    broadcast('resync', '{}');
  } catch (error) {
    console.error('Realtime: не удалось подключиться к БД:', error.message);
    reconnect();
  }
}

export function startRealtime() {
  stopped = false;
  connect();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

export function stopRealtime() {
  stopped = true;
  clearTimeout(reconnectTimer);
  for (const res of clients) res.end();
  clients.clear();
  if (listener) listener.end().catch(() => {});
}

// GET /api/events: поток Server-Sent Events для авторизованного пользователя.
export function handleEvents(req, res) {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // nginx не должен буферизовать поток.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
