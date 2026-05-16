// Cloudflare Worker — proxies two GitHub endpoints that don't send CORS headers:
//
//   POST /oauth/token            → forwards form-encoded body to
//                                  https://github.com/login/oauth/access_token
//                                  with the OAuth App client_secret injected
//                                  server-side. PKCE params from the browser
//                                  pass through as defense in depth (GitHub
//                                  OAuth Apps currently ignore code_verifier
//                                  but still require client_secret).
//   POST /?owner=&repo=&...      → forwards body to
//                                  https://uploads.github.com/repos/.../releases/.../assets
//                                  for browser-originated asset uploads.
//
// Deploy via Cloudflare Dashboard:
//   1. Cloudflare → Workers & Pages → Create application → Create Worker
//   2. Replace the default code with this file's contents → Deploy
//   3. Settings → Variables and Secrets → add secret GITHUB_CLIENT_SECRET
//      (paste the OAuth App's client secret from
//       https://github.com/settings/developers)
//   4. Copy the worker's URL (e.g. https://notebooklm-upload.<sub>.workers.dev)
//   5. Paste it into UPLOAD_PROXY_BASE in assets/js/uploader.js and
//      TOKEN_PROXY_URL in assets/js/auth.js
//
// Notes / limits:
//   - Cloudflare Workers Free has a 100 MB request body cap for uploads. Workers Paid raises it.
//   - GITHUB_CLIENT_SECRET lives only in the Worker. The browser never sees it.
//   - The upload Worker does NOT store the user token; it only passes the
//     Authorization header through.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(req) });
    }

    if (url.pathname === '/oauth/token') {
      if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: cors(req) });
      }
      return relayOAuthToken(req, env);
    }

    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors(req) });
    }
    return relayUpload(req, url);
  },
};

async function relayOAuthToken(req, env) {
  if (!env.GITHUB_CLIENT_SECRET) {
    return new Response(
      JSON.stringify({ error: 'server_misconfigured', error_description: 'GITHUB_CLIENT_SECRET is not set on the Worker' }),
      { status: 500, headers: { ...cors(req), 'Content-Type': 'application/json' } }
    );
  }

  // Re-parse the form body so we can inject client_secret without trusting the
  // browser to have sent one. We forward everything the browser sent
  // (client_id, code, code_verifier, redirect_uri, grant_type) verbatim and
  // add client_secret here.
  const raw = await req.text();
  const params = new URLSearchParams(raw);
  params.set('client_secret', env.GITHUB_CLIENT_SECRET);

  const ghRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });
  const respHeaders = new Headers(cors(req));
  respHeaders.set('Content-Type', ghRes.headers.get('Content-Type') || 'application/json');
  return new Response(ghRes.body, { status: ghRes.status, headers: respHeaders });
}

async function relayUpload(req, url) {
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
}

function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}
