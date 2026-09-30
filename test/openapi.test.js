import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenApiSpec, rpcDocs } from '../server/openapi/index.js';
import { rpcHandlers } from '../server/rpc.js';

test('OpenAPI documents every RPC method and nothing else', () => {
  const handlers = Object.keys(rpcHandlers).sort();
  const documented = Object.keys(rpcDocs).sort();

  assert.deepEqual(documented, handlers);
});

test('RPC docs have tag, summary and schemas', () => {
  const spec = buildOpenApiSpec();
  const tags = new Set(spec.tags.map(tag => tag.name));

  for (const [name, doc] of Object.entries(rpcDocs)) {
    assert.ok(tags.has(doc.tag), `${name}: unknown tag ${doc.tag}`);
    assert.ok(doc.summary && doc.summary.length <= 120, `${name}: summary`);
    assert.ok(doc.args === null || typeof doc.args === 'object', `${name}: args`);
    assert.ok(doc.result && typeof doc.result === 'object', `${name}: result`);
    assert.ok(spec.paths[`/api/rpc/${name}`].post, `${name}: path`);
  }
});

test('OpenAPI spec is serializable and references only declared security schemes', () => {
  const spec = JSON.parse(JSON.stringify(buildOpenApiSpec()));
  const schemes = new Set(Object.keys(spec.components.securitySchemes));

  assert.equal(spec.openapi, '3.1.0');

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      for (const requirement of operation.security || []) {
        for (const scheme of Object.keys(requirement)) {
          assert.ok(schemes.has(scheme), `${method.toUpperCase()} ${path}: ${scheme}`);
        }
      }
    }
  }
});
