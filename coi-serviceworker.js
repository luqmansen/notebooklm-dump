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

      console.log('coi-sw: injecting COOP/COEP into', req.url);
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
          .catch((err) => {
            console.error('coi-sw fetch error:', err);
            throw err;
          })
      );
    });
    return;
  }

  // ----- page context -----
  // Use a *timestamp* in the flag so it expires after a cooldown — sessionStorage
  // is per-tab and per-tab-restore, so a stale flag from a broken session could
  // otherwise lock the user out of all retry attempts.
  const RELOAD_KEY = 'coi-sw-last-reload';
  const COOLDOWN_MS = 5 * 1000; // short cooldown — long enough to prevent loops, short enough to allow quick retry

  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(RELOAD_KEY);
    return;
  }
  if (!('serviceWorker' in navigator)) {
    console.warn('coi-sw: serviceWorker not supported — multi-threaded WASM disabled');
    return;
  }
  const lastReload = parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10);
  if (lastReload && Date.now() - lastReload < COOLDOWN_MS) {
    console.warn(
      `coi-sw: recent reload attempt ${Math.round((Date.now() - lastReload) / 1000)}s ago, ` +
      `not retrying for another ${Math.round((COOLDOWN_MS - (Date.now() - lastReload)) / 1000)}s. ` +
      'Hard-refresh after that, or unregister the SW via DevTools.'
    );
    return;
  }

  // Default scope is the SW script's directory — for /notebooklm-dump/coi-serviceworker.js
  // that's /notebooklm-dump/, which is exactly what we want. Don't pass an explicit scope:
  // Pages doesn't send Service-Worker-Allowed, so any wider scope fails registration.
  navigator.serviceWorker.register(document.currentScript.src)
    .then((reg) => {
      console.log('coi-sw: registered, scope:', reg.scope);
      const reloadOnce = () => {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        location.reload();
      };

      // If the SW is already controlling this page but we're still not isolated,
      // the page was likely loaded BEFORE the SW activated (race) or restored from
      // bfcache. Reload — the SW will now intercept and add the headers.
      if (navigator.serviceWorker.controller) {
        reloadOnce();
        return;
      }
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    })
    .catch((err) => console.error('coi-sw register failed:', err));

  // Handle back-forward cache restores. If the user navigates away (e.g. to
  // index.html) and back, the browser may restore upload.html from bfcache in
  // its previous non-isolated state. Reload when that happens.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !window.crossOriginIsolated) {
      console.log('coi-sw: bfcache restore detected, reloading for COI');
      location.reload();
    }
  });
})();
