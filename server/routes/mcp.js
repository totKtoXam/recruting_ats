// MCP-сервер ATS (Model Context Protocol, транспорт Streamable HTTP без сессий):
// POST /mcp принимает JSON-RPC и отвечает JSON. Авторизация — Bearer-токен OAuth
// (см. routes/oauth.js); инструменты выполняются от имени владельца токена.
import express from 'express';
import { config } from '../config.js';
import { toPublicError } from '../lib/errors.js';
import { MCP_INSTRUCTIONS, mcpTools } from '../mcp/tools.js';
import { uploadsRouter } from '../mcp/uploads.js';
import { authenticateAccessToken } from '../services/oauth.js';
import { allowAnyOrigin, protectedResourceMetadataUrl } from './oauth.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'recruiting-ats', title: 'Recruiting ATS', version: '1.0.0' };

const toolsByName = new Map(mcpTools.map(tool => [tool.name, tool]));

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

// Ссылки на файлы и страницы ATS внутри приложения относительные (/hr-ats/files/...) —
// для клиента вне браузера делаем их абсолютными.
const ORIGIN = new URL(config.publicUrl).origin;
const RELATIVE_APP_URL = new RegExp('^' + (config.basePath || '') + '/(files|candidates)/');

function absolutizeUrls(value) {
  if (typeof value === 'string') {
    return RELATIVE_APP_URL.test(value) ? ORIGIN + value : value;
  }

  if (Array.isArray(value)) {
    return value.map(absolutizeUrls);
  }

  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, absolutizeUrls(item)]));
  }

  return value;
}

async function callTool(params, context) {
  const tool = toolsByName.get(params && params.name);

  if (!tool) {
    return { error: { code: -32602, message: `Неизвестный инструмент: ${params && params.name}` } };
  }

  try {
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const data = absolutizeUrls(await tool.handler(args, context));
    const structured = data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data ?? null };

    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 1) }],
        structuredContent: structured
      }
    };
  } catch (error) {
    const publicError = toPublicError(error);

    if (!publicError) {
      console.error(`MCP tool ${tool.name} failed:`, error);
    }

    // Ошибки бизнес-правил возвращаются как результат инструмента, чтобы модель могла их исправить.
    return {
      result: {
        content: [{ type: 'text', text: publicError ? publicError.message : 'Внутренняя ошибка сервера.' }],
        isError: true
      }
    };
  }
}

export async function handleMessage(message, context) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && message.id, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (isNotification) {
    return null;
  }

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;

      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: MCP_INSTRUCTIONS
      });
    }

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, {
        tools: mcpTools.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations
        }))
      });

    case 'tools/call': {
      const { result, error } = await callTool(params, context);
      return error ? rpcError(id, error.code, error.message) : rpcResult(id, result);
    }

    case 'resources/list':
      return rpcResult(id, { resources: [] });

    case 'prompts/list':
      return rpcResult(id, { prompts: [] });

    default:
      return rpcError(id, -32601, `Метод не поддерживается: ${method}`);
  }
}

function unauthorized(res, description) {
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      `Bearer resource_metadata="${protectedResourceMetadataUrl()}", error="invalid_token", error_description="${description}"`
    )
    .json(rpcError(null, -32001, description));
}

async function requireBearer(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);

    if (!match) {
      return unauthorized(res, 'Authorization required');
    }

    const auth = await authenticateAccessToken(match[1].trim());

    if (!auth) {
      return unauthorized(res, 'Invalid or expired token');
    }

    req.user = auth.user;
    next();
  } catch (error) {
    next(error);
  }
}

export function mcpRouter() {
  const router = express.Router();

  router.use('/mcp', allowAnyOrigin);
  router.use(uploadsRouter());

  router.post('/mcp', requireBearer, express.json({ limit: '20mb' }), async (req, res) => {
    const body = req.body;
    const context = { user: req.user };

    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(message => handleMessage(message, context)))).filter(Boolean);
      return responses.length ? res.json(responses) : res.status(202).end();
    }

    const response = await handleMessage(body, context);
    return response ? res.json(response) : res.status(202).end();
  });

  // Сервер не открывает SSE-поток и не хранит сессии.
  router.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed'));
  });

  return router;
}
