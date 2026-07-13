// sw.js — Service Worker for COOP/COEP headers (GitHub Pages workaround)
//
// GitHub Pages doesn't set Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy
// headers, which are required for SharedArrayBuffer (used by xeus-cpp WASM).
// This service worker intercepts all responses and injects those headers.
//
// On K8s (nginx), these headers are already set by nginx. This SW is harmless
// there since it just re-sets the same headers. But it's essential on GitHub Pages.
//
// Based on the well-known workaround: https://glitch.com/~co-op-coep

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then((response) => {
      // Don't modify opaque or error responses
      if (response.status === 0 || response.type === 'opaque') return response;

      // Clone the response and add COOP/COEP/CORP headers
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
      // Use 'credentialless' instead of 'require-corp' to allow WebLLM to
      // fetch cross-origin model files (e.g., from Hugging Face CDN) without
      // requiring those servers to set CORP headers. 'credentialless' strips
      // credentials from cross-origin requests but still enables
      // SharedArrayBuffer.
      newHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
      newHeaders.set('Cross-Origin-Resource-Policy', 'same-origin');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }).catch((e) => {
      console.error('[sw] Fetch failed:', e);
      throw e;
    })
  );
});
