// COI service-worker shim: inject Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy response headers so SharedArrayBuffer
// (and therefore multi-threaded ffmpeg.wasm) works on GitHub Pages.
//
// GitHub Pages doesn't let us set custom response headers, so we register a
// service worker that intercepts fetches and rewrites the headers on the way
// back to the page. Same-origin idea, no infra needed beyond this file.
//
// Adapted from https://github.com/gzuidhof/coi-serviceworker (MIT), with two
// safety changes to prevent infinite-reload loops:
//   1. No `updatefound → reload` handler. (Periodic SW update checks see the
//      response as "changed" once the SW adds COOP/COEP to its own script,
//      which used to trigger an endless reload cycle.)
//   2. A sessionStorage guard so we only attempt one reload per session. If
//      we reload and the page still isn't crossOriginIsolated, we bail with
//      a console warning instead of looping.

(function () {
  // ----- service worker context -----
  if (typeof window === 'undefined') {
    self.addEventListener('install',  () => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

    self.addEventListener('fetch', (e) => {
      const req = e.request;

      if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

      // Don't rewrite the SW script itself — keeps `updatefound` from firing
      // on every periodic update check.
      const url = new URL(req.url);
      if (url.pathname.endsWith('/coi-serviceworker.js')) return;

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

  navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
    const reloadOnce = () => {
      sessionStorage.setItem(RELOAD_KEY, '1');
      location.reload();
    };

    if (reg.active && !navigator.serviceWorker.controller) {
      // Existing SW but not yet controlling this page: one reload puts it in charge.
      reloadOnce();
      return;
    }

    if (!reg.active) {
      // First-time install: reload when the new SW activates.
      const sw = reg.installing || reg.waiting;
      if (sw) {
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated') reloadOnce();
        });
      }
    }
  }).catch((err) => console.error('coi-sw register failed:', err));
})();
