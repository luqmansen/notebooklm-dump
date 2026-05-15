// Cloudflare Worker — proxies asset uploads to uploads.github.com so the browser
// can avoid the missing CORS headers on that endpoint.
//
// Deploy via Cloudflare Dashboard:
//   1. Cloudflare → Workers & Pages → Create application → Create Worker
//   2. Replace the default code with this file's contents → Deploy
//   3. Copy the worker's URL (e.g. https://notebooklm-upload.<sub>.workers.dev)
//   4. Paste it into UPLOAD_PROXY_BASE in assets/js/uploader.js
//
// The Worker is a thin streaming pipe. It:
//   - accepts a POST from the browser
//   - reads ?owner=&repo=&release_id=&name= from the query string
//   - forwards the body and Authorization header to GitHub
//   - returns GitHub's response with permissive CORS headers
//
// Notes / limits:
//   - Cloudflare Workers Free has a 100 MB request body cap. Workers Paid raises it.
//     Files larger than that need either Workers Paid or a different upload path.
//   - The Worker does NOT store the token; it only passes the Authorization header through.
//   - Restrict the deployment to your own routes if you want stricter access control.

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(req) });
    }
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors(req) });
    }

    const url = new URL(req.url);
    const owner     = url.searchParams.get('owner');
    const repo      = url.searchParams.get('repo');
    const releaseId = url.searchParams.get('release_id');
    const name      = url.searchParams.get('name');
    if (!owner || !repo || !releaseId || !name) {
      return new Response(
        'Missing required query params: owner, repo, release_id, name',
        { status: 400, headers: { ...cors(req), 'Content-Type': 'text/plain' } }
      );
    }

    const auth = req.headers.get('Authorization');
    if (!auth) {
      return new Response('Missing Authorization header', {
        status: 401,
        headers: { ...cors(req), 'Content-Type': 'text/plain' },
      });
    }

    const target = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;

    const ghRes = await fetch(target, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': req.headers.get('Content-Type') || 'application/octet-stream',
        Accept: 'application/vnd.github+json',
      },
      body: req.body,
    });

    const respHeaders = new Headers(cors(req));
    respHeaders.set('Content-Type', ghRes.headers.get('Content-Type') || 'application/json');

    return new Response(ghRes.body, {
      status: ghRes.status,
      headers: respHeaders,
    });
  },
};

function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}
