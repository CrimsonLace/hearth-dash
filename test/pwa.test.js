import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationHandler } from '../worker.js';
import {
  PWA_CACHE_ALLOWLIST, PWA_MANIFEST, PWA_SERVICE_WORKER_SOURCE,
} from '../pwa.js';

const testEnv = {
  DASHBOARD_PASSWORD: 'test-password',
  SESSION_SECRET: 'test-session-secret',
  DB: {
    prepare() {
      return { bind() { return { run: async () => ({ success: true }), first: async () => ({ count: 1 }) }; } };
    },
  },
};
const context = { waitUntil() {}, passThroughOnException() {} };

test('manifest describes the shared Hearth app and required Android icon purposes', async () => {
  const response = await request('/manifest.webmanifest');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  const manifest = await response.json();
  assert.equal(manifest.name, 'Hearth');
  assert.equal(manifest.short_name, 'Hearth');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons, PWA_MANIFEST.icons);
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
});

test('all declared PNG assets resolve anonymously with the PNG signature', async () => {
  const paths = [...new Set(PWA_MANIFEST.icons.map(icon => icon.src).concat('/icons/favicon-64.png'))];
  for (const path of paths) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'image/png', path);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], path);
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expectedSize = path.includes('192') ? 192 : path.includes('64') ? 64 : 512;
    assert.equal(size.getUint32(16), expectedSize, `${path} width`);
    assert.equal(size.getUint32(20), expectedSize, `${path} height`);
  }
});

test('service worker registers at root and caches only the explicit public asset allowlist', async () => {
  assert.deepEqual(PWA_CACHE_ALLOWLIST, [
    '/manifest.webmanifest', '/icons/favicon-64.png', '/icons/hearth-192.png',
    '/icons/hearth-512.png', '/icons/hearth-512-maskable.png',
  ]);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /request\.method !== 'GET'/);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /request\.mode === 'navigate'/);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /request\.headers\.has\('Authorization'\)/);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /STATIC_PATH_SET\.has\(url\.pathname\)/);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /url\.pathname\.startsWith\('\/oauth\/'\)/);
  assert.doesNotMatch(PWA_SERVICE_WORKER_SOURCE, /caches\.match\([^)]*request\.url/);

  const response = await request('/sw.js');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(response.headers.get('service-worker-allowed'), '/');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(await response.text(), PWA_SERVICE_WORKER_SOURCE);
});

test('install metadata is linked on both dashboard and normal login, without changing auth caching', async () => {
  const login = await request('/login');
  const html = await login.text();
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
  assert.match(html, /name="password"/);
  assert.match(html, /method="POST" action="\/login"/);
});

test('private API and navigation requests are not cached offline; signed-out app entry keeps normal login redirect', async () => {
  const response = await request('/');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://hearth.example/login');
  assert.equal(response.headers.get('cache-control'), null);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /request\.mode === 'navigate'/);
  assert.match(PWA_SERVICE_WORKER_SOURCE, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(PWA_CACHE_ALLOWLIST.join('\n'), /\/api\/|\/login|\/oauth\//);
});

test('mobile rules keep content within the viewport and make controls touch-sized', async () => {
  const response = await request('/', { cookie: await createValidSessionCookie() });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(html, /@media\(max-width:650px\)/);
  assert.match(html, /overflow-x:clip/);
  assert.match(html, /min-height:48px/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /overscroll-behavior-x:contain/);
  assert.match(html, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
});

async function request(path, options = {}) {
  const headers = options.cookie ? { Cookie: `__Host-hearth_session=${options.cookie}` } : {};
  return applicationHandler.fetch(new Request(`https://hearth.example${path}`, { headers }), testEnv, context);
}

async function createValidSessionCookie() {
  // The session helper is intentionally private; obtain a valid cookie via the normal same-origin login flow.
  const form = new URLSearchParams({ password: testEnv.DASHBOARD_PASSWORD });
  const response = await applicationHandler.fetch(new Request('https://hearth.example/login', {
    method: 'POST',
    headers: { Origin: 'https://hearth.example', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  }), testEnv, context);
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').match(/__Host-hearth_session=([^;]+)/)[1];
}
