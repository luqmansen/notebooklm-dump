// COI service-worker shim: inject Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy response headers so SharedArrayBuffer
// (and therefore multi-threaded ffmpeg.wasm) works on GitHub Pages.
//
// CRITICAL: this file MUST live at the site root so the SW's scope is `/`.
// Service workers are scoped to their own directory by default — if this file
// lives under /assets/js/, the SW only sees requests under that path and will
// NEVER intercept the upload.html document load.
//
// We deliberately only inject COOP/COEP for the upload.html *document*, not
// every response. Adding them site-wide would also affect index.html, whose
// audio playback fetches release-assets.githubusercontent.com URLs that don't
// send Cross-Origin-Resource-Policy headers — under COEP: require-corp those
// would be blocked and the player would break.
//
// Adapted from https://github.com/gzuidhof/coi-serviceworker (MIT), hardened
// against an infinite-reload loop we hit earlier.

(function () {
  // ----- service worker context -----
  if (typeof window === 'undefined') {
    self.addEventListener('install',  () => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

    self.addEventListener('fetch', (e) => {
      const req = e.request;
      if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

      const url = new URL(req.url);

      // Only add COOP/COEP to the upload.html *document* load. Subresources
      // don't need the headers themselves; they just need to be CORS/CORP-
      // compliant (jsdelivr scripts already are via crossorigin="anonymous").
      const isUploadDoc = req.mode === 'navigate' && url.pathname.endsWith('/upload.html');
      if (!isUploadDoc) return; // pass through — browser handles normally

      e.respondWith(
        fetch(req)
          .then((res) => {
            if (res.status === 0) return res;
            const headers = new Headers(res.headers);
            headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
            headers.set('Cross-Origin-Opener-Policy', 'same-origin');
            return new Response(res.body, {
              status: res.status,
              statusText: res.statusText,
              headers,
            });
          })
          .catch((err) => console.error('coi-sw fetch error:', err))
      );
    });
    return;
  }

  // ----- page context -----
  const RELOAD_KEY = 'coi-sw-reload-attempted';

  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(RELOAD_KEY);
    return;
  }
  if (!('serviceWorker' in navigator)) {
    console.warn('coi-sw: serviceWorker not supported — multi-threaded WASM disabled');
    return;
  }
  if (sessionStorage.getItem(RELOAD_KEY)) {
    console.warn(
      'coi-sw: already reloaded once and crossOriginIsolated still false. ' +
      'Not reloading again to avoid a loop. Multi-threaded WASM will not be available.'
    );
    return;
  }

  navigator.serviceWorker.register(document.currentScript.src, { scope: '/' })
    .then((reg) => {
      const reloadOnce = () => {
        sessionStorage.setItem(RELOAD_KEY, '1');
        location.reload();
      };

      if (reg.active && !navigator.serviceWorker.controller) {
        reloadOnce();
        return;
      }

      if (!reg.active) {
        const sw = reg.installing || reg.waiting;
        if (sw) {
          sw.addEventListener('statechange', () => {
            if (sw.state === 'activated') reloadOnce();
          });
        }
      }
    })
    .catch((err) => console.error('coi-sw register failed:', err));
})();
