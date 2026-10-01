#!/usr/bin/env node
import { createInterface } from 'node:readline';

const ATS_URL = process.env.ATS_MCP_URL?.trim() ||
  'https://portal.devexpert.kz/hr-ats/mcp';
const token = process.env.ATS_MCP_TOKEN?.trim();

if (!token) {
  process.stderr.write('ATS_MCP_TOKEN is required.\n');
  process.exit(2);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' }
    }) + '\n');
    continue;
  }

  const hasId = message !== null && typeof message === 'object' &&
    Object.hasOwn(message, 'id') && message.id !== null;

  try {
    const response = await fetch(ATS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(600_000)
    });

    if (response.status === 202) continue;
    if (!response.ok) {
      if (hasId) {
        const status = response.status === 401 ? 'ATS rejected the API token' :
          `ATS MCP request failed (HTTP ${response.status})`;
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          error: { code: -32000, message: status }
        }) + '\n');
      }
      continue;
    }

    const body = await response.json();
    if (body !== null) process.stdout.write(JSON.stringify(body) + '\n');
  } catch {
    if (hasId) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        error: { code: -32000, message: 'ATS MCP connection failed' }
      }) + '\n');
    }
  }
}
