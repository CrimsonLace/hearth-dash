import { PWA_ICON_BASE64 } from './pwa-icons.js';

export const PWA_CACHE_ALLOWLIST = Object.freeze([
  '/manifest.webmanifest',
  '/icons/favicon-64.png',
  '/icons/hearth-192.png',
  '/icons/hearth-512.png',
  '/icons/hearth-512-maskable.png',
]);

export const PWA_MANIFEST = Object.freeze({
  id: '/',
  name: 'Hearth',
  short_name: 'Hearth',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  theme_color: '#241318',
  background_color: '#160e12',
  icons: [
    { src: '/icons/hearth-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/hearth-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/hearth-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

export const PWA_SERVICE_WORKER_SOURCE = `
const CACHE_NAME = 'hearth-static-1.1.4-crimson.5';
const STATIC_PATHS = ${JSON.stringify(PWA_CACHE_ALLOWLIST)};
const STATIC_PATH_SET = new Set(STATIC_PATHS);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_PATHS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('hearth-static-') && key !== CACHE_NAME).map(key => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode === 'navigate' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || !STATIC_PATH_SET.has(url.pathname)) return;
  // Private API, login, OAuth, and user-specific routes are never handled by the cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/') || url.pathname === '/authorize') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  })());
});
`;

export function getPwaIconBytes(path) {
  const encoded = PWA_ICON_BASE64[path];
  if (!encoded) return null;
  const binary = atob(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
