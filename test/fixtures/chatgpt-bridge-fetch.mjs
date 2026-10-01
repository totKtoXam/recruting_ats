globalThis.fetch = async (url, init) => {
  if (url !== 'https://portal.devexpert.kz/hr-ats/mcp' ||
      init.method !== 'POST' ||
      init.headers.Authorization !== 'Bearer test-token' ||
      init.headers['Content-Type'] !== 'application/json') {
    throw new Error('Unexpected ATS request');
  }

  const message = JSON.parse(init.body);
  if (message.method === 'notifications/initialized') {
    return new Response(null, { status: 202 });
  }
  if (message.method === 'initialize') {
    return Response.json({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'recruiting-ats', version: '1.0.0' }
    } });
  }
  if (message.method === 'tools/list') {
    return Response.json({ jsonrpc: '2.0', id: message.id,
      result: { tools: [{ name: 'search_candidates', inputSchema: { type: 'object' } }] } });
  }
  if (message.method === 'tools/call') {
    return new Response(null, { status: 401 });
  }
  throw new Error('Unexpected MCP method');
};
