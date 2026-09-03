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
