import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMessage } from '../server/routes/mcp.js';
import { mcpTools } from '../server/mcp/tools.js';
import { isAllowedRedirectUri } from '../server/services/oauth.js';

test('isAllowedRedirectUri accepts https and loopback, rejects others', () => {
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost:53123/callback',
    'http://127.0.0.1:8080/cb',
    'http://[::1]:9000/cb'
  ]) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
  }

  for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'ftp://localhost/cb', 'https://x.example/cb#frag', 'not a url']) {
    assert.equal(isAllowedRedirectUri(uri), false, uri);
  }
});

test('MCP tools have unique names, object schemas and confirmation hints on writes', () => {
  const names = mcpTools.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length);

  for (const tool of mcpTools) {
    assert.match(tool.name, /^[a-z_]+$/);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(typeof tool.handler, 'function', tool.name);

    if (!tool.annotations.readOnlyHint) {
      assert.match(tool.description, /подтверждение/, `${tool.name} must ask for confirmation`);
    }
  }
});

test('MCP initialize negotiates protocol version and advertises tools', async () => {
  const known = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, {});
  assert.equal(known.result.protocolVersion, '2025-06-18');
  assert.ok(known.result.capabilities.tools);
  assert.match(known.result.instructions, /подтверждения/);

  const unknown = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, {});
  assert.equal(unknown.result.protocolVersion, '2025-11-25');
});

test('MCP notifications get no response, unknown methods and tools return errors', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}), null);

  const method = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' }, {});
  assert.equal(method.error.code, -32601);

  const tool = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, {});
  assert.equal(tool.error.code, -32602);

  const invalid = await handleMessage({ id: 5, method: 'ping' }, {});
  assert.equal(invalid.error.code, -32600);

  const list = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, {});
  assert.equal(list.result.tools.length, mcpTools.length);
  assert.equal(list.result.tools[0].handler, undefined);
});
