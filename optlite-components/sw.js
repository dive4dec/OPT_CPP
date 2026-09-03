// sw.js — Service Worker for OPT_CPP
//
// TWO JOBS:
//
// 1. COOP/COEP/CORP header injection. SharedArrayBuffer — required by the
//    xeus-cpp WASM kernel — is only enabled when the top-level document is
//    delivered with COOP + COEP. On GitHub Pages the server sets none of these;
//    on K8s (nginx) the *asset* responses carry them but the HTML *document*
//    does not. So this SW is what actually enables SharedArrayBuffer on BOTH
//    hosts: it intercepts same-origin GETs and re-emits them with the headers.
//
// 2. Kernel compression for serverless hosts (GitHub Pages). The xeus-cpp
//    kernel files total ~101 MB raw. nginx gzips them on K8s, but GitHub Pages
//    serves files as-is. Instead of depending on a server, the SW serves the
//    pre-compressed `.gz` sibling (shipped alongside each file) and decompresses
//    it in the browser with DecompressionStream('gzip') — dropping the wire
//    transfer to ~34 MB with zero server involvement. The emscripten loader
//    receives exactly the uncompressed bytes it always did, so no worker change.
//
//    The four big kernel binaries are fetched by the worker as plain
//    `fetch(url).arrayBuffer()` (verified in the generated xcpp.js: the .wasm
//    via readAsync, the .data via the loadPackage preload path, the .so side
//    modules via the wasm plugin). None use HEAD/Range/Content-Length, so a
//    SW-synthesized decompressed Response is safe for all of them.
//
// PROBE-FIRST DETECTION (keeps the working host untouched + low memory):
//   On the first kernel request the SW sends one tiny HEAD to the raw URL.
//     - Server returns Content-Encoding: gzip  (K8s/nginx): use the STANDARD
//       pass-through path — the browser gzip-decompresses the raw URL for free
//       (streamed Response, exactly today's behaviour, no kernel bytes held in
//       the SW's memory).
//     - Server does NOT compress                (GitHub Pages): fetch the `.gz`
//       sibling and decompress it in the SW.
//   The probe is a few hundred bytes, runs once and is cached per SW instance
//   (all kernel files share one host). A fetch() made *inside* the SW is not
//   re-intercepted by this SW's own fetch handler, so it cannot recurse. The
//   failure direction is safe: even on K8s a flaky probe just takes the .gz
//   path, which still yields correct bytes (the .gz exists on both hosts).
//
// CACHING / DEDUP:
//   - In-memory Map stores the COMPRESSED `.gz` bytes (~30 MB total, not the
//     95 MB decompressed) so the SW footprint stays small. The `.gz` is fetched
//     with {cache:'force-cache'}, so the browser HTTP cache serves it across
//     page loads (30d on K8s, CDN on GH Pages). Each consumer decompresses its
//     own fresh stream (a fast native op); a Response body is single-use, so
//     each consumer gets a brand-new decompressed stream.
//   - The Map also dedups the page-load warm-up + initial worker init, which
//     request the same kernel URL concurrently.
//
// ROBUSTNESS: if DecompressionStream is unavailable, the server compresses the
// raw URL, or the `.gz` is missing / errors, the SW serves the raw file.
// Never worse than before.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil((async () => {
    await self.clients.claim();
    // Prune stale kernel caches from earlier xeus-cpp versions (the name
    // embeds KERNEL_VERSION). Keep only the current one.
    const keys = await caches.keys();
    for (const k of keys) {
      if (k.startsWith('optcpp-kernel-') && k !== PRECACHE_NAME) {
        await caches.delete(k);
      }
      // Superseded cache names from earlier iterations of the offline layer.
      if (k === 'optcpp-runtime') {
        await caches.delete(k);
      }
    }
    // Background-fill the kernel precache (best-effort; never blocks activation
    // and never worse than before). Populates the Cache API with the ~34 MB of
    // compressed kernel so the app works OFFLINE after the first visit, even
    // if the browser evicts its normal HTTP cache.
    ensureKernelPrecache().catch((e) => console.warn('[sw] kernel precache skipped:', e));
    console.info('[sw] OPT_CPP kernel-gz service worker active');
  })())
);

// Populate the versioned kernel precache with the pre-compressed `.gz` siblings
// (which exist on both K8s and serverless hosts). Idempotent: skips files
// already present. Sourced directly from the `.gz` so it works regardless of
// the host's compression mode (independent of the HEAD probe below).
async function ensureKernelPrecache() {
  if (!('caches' in self)) return;
  const cache = await caches.open(PRECACHE_NAME);
  // Derive the kernel base relative to THIS script (works for both root and
  // /OPT_CPP/-style PUBLIC_PATH deployments, matching the worker's own path).
  const base = new URL('./xeus-cpp/', self.location.href).href;
  const files = ['xcpp.wasm', 'xcpp.data', 'libclangCppInterOp.so', 'libxeus.so'];
  await Promise.all(files.map(async (f) => {
    const key = base + f + '.gz?v=' + KERNEL_VERSION;
    if (await cache.match(key)) return; // already cached
    const r = await fetch(key, { cache: 'force-cache' });
    if (!r.ok) throw new Error('precache ' + f + ' -> HTTP ' + r.status);
    await cache.put(key, new Response(await r.arrayBuffer(), {
      status: 200,
      headers: withCoopCoep(r.headers),
    }));
  }));
}

// Kernel binaries that have a pre-compressed `.gz` sibling. Only the big
// binary files are decompressed here (~99.5% of the 101 MB; fetched as opaque
// arrayBuffers). xcpp.js (a 2.2 MB text script) stays on the raw pass-through
// path — a small saving, and keeping it out avoids content-type edge cases for
// a JS script (it's loaded via importScripts and is gzipped by the server
// either way).
const KERNEL_GZ = new Set([
  'xcpp.wasm',
  'xcpp.data',
  'libclangCppInterOp.so',
  'libxeus.so',
]);

// Kernel version (must match the ?v= the worker's emscripten locateFile uses,
// see cppworker.js + runner.ts warm-up). The precache name carries it, so a
// xeus-cpp bump gets a fresh cache and the stale one is pruned on activate.
const KERNEL_VERSION = '0.10.0';
const PRECACHE_NAME = 'optcpp-kernel-' + KERNEL_VERSION;

// ── Static-app offline layer (network-first + cache-fallback) ───────────────
// Everything the app loads from the SAME origin is made offline-reliable here,
// so that once a user has visited the page online, re-running (or even a cold
// visit) works with the network off — the same model OPT_Mentor relies on via
// its JupyterLite service-worker precache.
//
// This covers the worker's script chunk (801.<hash>.bundle.js), the main
// bundles, tree-sitter.js/.wasm, the tree-sitter-cpp grammar, and the worker's
// importScripts (instrument.js / ts-reformat.js / opt_trace.h). The latter are
// requested with ?v=Date.now() (a fresh URL every run — see cppworker.js); we
// key the cache by the QUERY-LESS url so the ever-changing ?v= resolves to the
// same last-good copy instead of a dead, never-seen URL. (That per-run cache-
// bust was the root cause of "offline → Compilation error": the worker's
// script chunk + importScripts had no offline source and died before the
// kernel loaded. Proven in the offline-sim.)
//
// Network-first means ALWAYS FRESH when online (no 30-day staleness — which is
// why the original author added the ?v=Date.now() cache-bust), while
// cache-fallback means the last good copy is served when offline. No worker
// change is required: the SW intercepts the worker's own importScripts/fetch.
//
// Paths deliberately EXCLUDED from this layer:
//   /sw.js      — must stay no-cache so SW updates propagate on next load.
//   /ai-proxy/  — a live backend proxy, never a static asset; never cache.
//   *.html docs + extensionless paths — page navigation stays on the standard
//   COOP/COEP pass-through (unchanged behaviour); only static *asset* files are
//   mirrored to the offline cache. (Re-running an already-loaded page never
//   re-fetches the document, so the doc doesn't need an offline copy.)
const ASSETS_CACHE = 'optcpp-assets';
const ASSET_EXT = /\.(js|mjs|css|wasm|data|h|ico|png|jpe?g|gif|svg|map|ttf|otf|woff2?|whl)$/i;

// True for a same-origin GET to a static *asset* file this layer should
// cache-serve (excludes documents, sw.js, the ai-proxy, and extensionless URLs).
function isAppAsset(request) {
  if (request.method !== 'GET') return false;
  const u = new URL(request.url);
  if (u.origin !== self.location.origin) return false;
  const p = u.pathname;
  if (p.endsWith('/sw.js')) return false;
  if (p.includes('/ai-proxy')) return false;
  if (!ASSET_EXT.test(p)) return false;   // only real asset files, not docs
  // The webpack ENTRY bundles (opt-live.<hash>.bundle.js / visualize.<hash>.bundle.js)
  // are loaded ONCE by the document and never re-fetched on re-run, so they stay
  // on the fast streaming pass-through (no 6.8 MB SW buffer / per-build cache
  // growth). They're the NAMED chunks; the worker + split chunks are the NUMERIC
  // ones (e.g. 801.<hash>.bundle.js) and ARE re-fetched on re-run, so they're
  // cached. Excluding by entry-name prefix is stable (fixed webpack entry names).
  const base = baseName(request.url);
  if (/^(opt-live|visualize)\./.test(base || '')) return false;
  return true;
}

// Query-less cache key so ?v=Date.now() (and ?v=0.10.0) resolve to one entry.
function assetKey(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

// Network-first (fresh when online) + cache-fallback (last good copy offline).
// Uses the DEFAULT cache mode (plain fetch) so the browser's HTTP cache is
// honoured online: content-hashed bundles stay on nginx's `immutable 30d` (no
// re-fetch between deploys) and the ?v=Date.now() trio refetches (tiny). The
// Cache API is only a backup for offline — every online success is (re)stored
// so the freshest copy is always what we'd serve offline.
async function serveAsset(request) {
  const key = assetKey(request.url);
  let cache;
  try { cache = await caches.open(ASSETS_CACHE); } catch (e) { cache = null; }
  try {
    const fresh = await fetch(request);
    if (fresh.ok || fresh.type === 'basic') {
      const body = await fresh.arrayBuffer();
      const headers = withCoopCoep(fresh.headers);
      if (cache) await cache.put(key, new Response(body, { status: 200, headers })).catch(() => {});
      return new Response(body, { status: fresh.status, statusText: fresh.statusText, headers });
    }
    // Non-2xx: prefer a good cached copy, else pass the error through.
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    return fresh;
  } catch (netErr) {
    // Offline (or network failed): serve the last good copy from cache.
    if (cache) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    throw netErr;
  }
}

// Canonical URL of the pre-compressed sibling of a raw kernel URL — e.g.
// .../xcpp.wasm?v=0.10.0  ->  .../xcpp.wasm.gz?v=0.10.0. Used as the single
// Cache API key so precache / warm / read all agree on the same entry.
function gzUrlFor(rawUrl) {
  const u = new URL(rawUrl);
  u.pathname += '.gz';
  return u.toString();
}

// rawUrl -> Promise<{ gz: Uint8Array, cacheControl: string|null }>
const gzCache = new Map();
// 'server' | 'gz' | undefined (probed once per SW instance)
let hostCompression;

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetchWithHeaders(request).catch((e) => {
      console.error('[sw] Fetch failed:', e);
      // If a kernel binary couldn't be served (e.g. the user is offline and
      // nothing is cached yet), drop the cached host-compression decision so
      // the next request re-probes. A probe made during a transient offline
      // must not persist and pin the wrong path. (The decompress fallback in
      // fetchWithHeaders already recovers from .gz-path errors; this guards the
      // whole-serve-failed case.)
      if (baseName(request.url) && KERNEL_GZ.has(baseName(request.url))) {
        hostCompression = undefined;
      }
      throw e;
    })
  );
});

async function fetchWithHeaders(request) {
  const base = baseName(request.url);

  // Kernel big binaries use the .gz decompression path below (wire compression
  // + kernel precache). Everything ELSE the app loads from this origin — the
  // worker's script chunk, main bundles, xcpp.js, tree-sitter.js/.wasm, the
  // tree-sitter-cpp grammar, and the worker's importScripts trio (instrument.js
  // / ts-reformat.js / opt_trace.h, requested with ?v=Date.now()) — is served
  // network-first with a cache-fallback, keyed by the query-less URL: always
  // fresh when online, available offline. This is what makes re-running (and a
  // cold visit) work with the network off.
  if (isAppAsset(request) && !(base && KERNEL_GZ.has(base))) {
    return serveAsset(request);
  }

  // Kernel compression path — only for kernel binaries, and only when the host
  // does NOT already gzip the raw URL (i.e. a serverless host like GH Pages).
  if (
    base &&
    KERNEL_GZ.has(base) &&
    typeof DecompressionStream !== 'undefined' &&
    (await hostCompressionFor(request.url)) === 'gz'
  ) {
    try {
      const { gz, cacheControl } = await getGz(request.url);
      const headers = withCoopCoep(null);
      headers.set('Content-Type', contentTypeFor(base));
      if (cacheControl) headers.set('Cache-Control', cacheControl);
      // Fresh decompressed stream for this consumer.
      const stream = new Blob([gz]).stream().pipeThrough(
        new DecompressionStream('gzip')
      );
      return new Response(stream, { status: 200, headers });
    } catch (e) {
      console.warn('[sw] kernel .gz path failed, falling back to raw:', e);
      // fall through to the raw fetch below
    }
  }

  // Standard path: fetch as usual, re-emit with COOP/COEP/CORP. On K8s the
  // browser auto-decompresses the server's gzip here (streamed Response).
  const response = await fetch(request);
  if (response.status === 0 || response.type === 'opaque') return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: withCoopCoep(response.headers),
  });
}

// Decide, once per SW instance, whether the host gzips kernel files.
async function hostCompressionFor(rawUrl) {
  if (hostCompression === undefined) {
    hostCompression = (await serverCompresses(rawUrl)) ? 'server' : 'gz';
  }
  return hostCompression;
}

// Tiny HEAD: does the server compress this raw URL with gzip? (true on K8s,
// false on GitHub Pages). A fetch() inside the SW is not re-intercepted by
// this SW's own fetch handler, so this cannot recurse.
async function serverCompresses(rawUrl) {
  try {
    const head = await fetch(rawUrl, { method: 'HEAD', cache: 'no-store' });
    return head.headers.get('content-encoding') === 'gzip';
  } catch (e) {
    return false; // probe failed — take the .gz path (safe: .gz on both hosts)
  }
}

// Fetch the `.gz` sibling once per raw URL and return its compressed bytes.
// Cache-first: the versioned kernel precache (Cache API) is checked first, so
// the kernel is served OFFLINE after the first visit without depending on the
// browser's volatile HTTP cache. On miss, fetch (force-cache also warms the
// HTTP cache) and store into the precache for next time. Deduped via gzCache
// for the concurrent warm-up + worker-init case.
function getGz(rawUrl) {
  if (gzCache.has(rawUrl)) return gzCache.get(rawUrl);

  const u = new URL(rawUrl);
  u.pathname += '.gz';
  const url = u.toString();

  const p = (async () => {
    let cacheControl = null;
    if ('caches' in self) {
      const cache = await caches.open(PRECACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        return { gz: new Uint8Array(await hit.arrayBuffer()), cacheControl: 'cache' };
      }
    }
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error('kernel .gz unavailable: ' + r.status);
    cacheControl = r.headers.get('Cache-Control');
    const bytes = new Uint8Array(await r.arrayBuffer());
    if ('caches' in self) {
      const cache = await caches.open(PRECACHE_NAME);
      await cache.put(url, new Response(bytes, {
        status: 200,
        headers: withCoopCoep(r.headers),
      })).catch(() => {});
    }
    return { gz: bytes, cacheControl };
  })();

  gzCache.set(rawUrl, p);
  // On failure, forget it so the next request retries (and can fall back).
  p.catch(() => gzCache.delete(rawUrl));
  return p;
}

function baseName(url) {
  try {
    const last = new URL(url).pathname.split('/').pop();
    return last ? last.split('?')[0] : null;
  } catch {
    return null;
  }
}

function contentTypeFor(base) {
  if (base.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function withCoopCoep(responseHeaders) {
  const h = new Headers(responseHeaders ?? []);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  // 'credentialless' (not 'require-corp') lets WebLLM fetch cross-origin model
  // files (e.g. Hugging Face CDN) without those servers setting CORP headers,
  // while still enabling SharedArrayBuffer.
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return h;
}
