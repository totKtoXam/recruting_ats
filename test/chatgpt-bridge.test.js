import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

for (const endpoint of ['', 'http://127.0.0.1:3040/hr-ats/mcp']) {
test(`ChatGPT bridge forwards MCP to ${endpoint || 'default ATS URL'} with bearer token`, async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const bridge = path.resolve(testDir, '../plugins/recruiting-ats-chatgpt/scripts/ats-mcp-stdio.mjs');
  const preload = pathToFileURL(path.join(testDir, 'fixtures/chatgpt-bridge-fetch.mjs')).href;
  const child = spawn(process.execPath, ['--import', preload, bridge], {
    env: { ...process.env, ATS_MCP_TOKEN: 'test-token', ATS_MCP_URL: endpoint }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' }
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_candidates' } }
  ].map(JSON.stringify).join('\n') + '\n');

  const exitCode = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);
  const messages = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].result.serverInfo.name, 'recruiting-ats');
  assert.equal(messages[1].result.tools[0].name, 'search_candidates');
  assert.equal(messages[2].error.message, 'ATS rejected the API token');
  assert(!stdout.includes('test-token'));
});
}
