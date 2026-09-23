import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OAUTH_SCOPES } from '../oauth-scopes.js';
import { resourceMcpScope } from '../resource-mcp.js';

const oauthEntry = await readFile(new URL('../oauth-entry.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../worker.js', import.meta.url), 'utf8');

test('authorization-server and protected-resource metadata share the canonical scopes', () => {
  assert.deepEqual(OAUTH_SCOPES, ['hearth:read', 'hearth:write']);
  assert.match(oauthEntry, /scopesSupported:\s*OAUTH_SCOPES/);
  assert.match(oauthEntry, /scopes_supported:\s*OAUTH_SCOPES/);
  assert.doesNotMatch(oauthEntry, /scopes_supported:\s*\[/);
  assert.match(oauthEntry, /clientIdMetadataDocumentEnabled:\s*true/);
  assert.match(oauthEntry, /accessTokenTTL:\s*3600/);
  assert.match(oauthEntry, /refreshTokenTTL:\s*30\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
});

test('one canonical scope definition also drives consent scope filtering', () => {
  assert.match(worker, /import\s*\{\s*OAUTH_SCOPES\s*\}\s*from\s*'\.\/oauth-scopes\.js'/);
  assert.doesNotMatch(worker, /const OAUTH_SCOPES\s*=/);
  assert.match(worker, /requestedScopes\.filter\(scope => OAUTH_SCOPES\.includes\(scope\)\)/);
});

test('typed resource MCP tools retain their read/write scope mapping', () => {
  assert.equal(resourceMcpScope('hearth_resource_read'), 'hearth:read');
  assert.equal(resourceMcpScope('hearth_resource_create'), 'hearth:write');
  assert.equal(resourceMcpScope('hearth_resource_update'), 'hearth:write');
});

