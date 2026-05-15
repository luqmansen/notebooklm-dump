// COI service-worker shim: inject Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy response headers so SharedArrayBuffer
// (and therefore multi-threaded ffmpeg.wasm) works on GitHub Pages.
//
// GitHub Pages doesn't let us set custom response headers, so we register a
// service worker that intercepts fetches and rewrites the headers on the way
// back to the page. Same-origin idea, no infra needed beyond this file.
//
// Adapted from https://github.com/gzuidhof/coi-serviceworker (MIT).

(function () {
  // Inside the service worker
  if (typeof window === 'undefined') {
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

    self.addEventListener('fetch', (e) => {
      const req = e.request;
      // Skip cache-only requests and requests from non-page contexts that don't need COOP/COEP
      if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

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

  // Inside the page
  if (!('serviceWorker' in navigator)) {
    console.warn('coi-sw: serviceWorker not supported; multi-threaded WASM disabled');
    return;
  }
  if (window.crossOriginIsolated) {
    // Already isolated; SW not needed (page already has the headers somehow)
    return;
  }
  const swSrc = document.currentScript.src;
  navigator.serviceWorker.register(swSrc).then((reg) => {
    reg.addEventListener('updatefound', () => location.reload());
    if (reg.active && !navigator.serviceWorker.controller) {
      // Existing SW but not controlling this page yet — reload once
      location.reload();
    } else if (!reg.active && !navigator.serviceWorker.controller) {
      // First-time install — wait for activation, then reload
      const newWorker = reg.installing || reg.waiting;
      if (newWorker) {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') location.reload();
        });
      }
    }
  }).catch((err) => console.error('coi-sw register failed', err));
})();
