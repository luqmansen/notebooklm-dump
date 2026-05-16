// OAuth flow with GitHub for the player's cross-device progress sync.
//
// Why an OAuth App and not a paste-PAT flow like upload.html: visitors should
// be able to sync without generating a PAT. Scope is `gist` only — the token
// cannot touch this or any other repo.
//
// Why a Worker proxy for the token exchange:
//   1. github.com/login/oauth/access_token sends NO Access-Control-Allow-Origin
//      headers (verified empirically 2026-05-16), so the browser cannot read
//      the response directly.
//   2. GitHub OAuth Apps require client_secret on the token exchange even when
//      the request carries a PKCE code_verifier (confirmed 2026-05-16 — GitHub
//      ignores code_verifier on OAuth Apps). The Worker injects client_secret
//      from its env so the browser never sees it.
//
// We still send code_challenge / code_verifier from the browser as defense in
// depth: an attacker who intercepts the auth code from the redirect can't
// redeem it without the verifier sitting in this tab's sessionStorage, even
// though GitHub doesn't enforce that today.

const CLIENT_ID       = 'Ov23lijxhsWUxPtzz4lN';
const TOKEN_PROXY_URL = 'https://notebooklm-upload.luqmansen.workers.dev/oauth/token';
const SCOPE           = 'gist';

const TOKEN_KEY    = 'gh_oauth_token';
const VERIFIER_KEY = 'pkce_verifier';
const STATE_KEY    = 'pkce_state';
const RETURN_KEY   = 'pkce_return_to';

function redirectUri() {
  return new URL('callback.html', location.href).href;
}

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomBase64url(byteLen) {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

async function sha256Base64url(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(digest);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function isAuthed() {
  return !!getToken();
}

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function signIn(returnTo) {
  const verifier  = randomBase64url(32);
  const state     = randomBase64url(16);
  const challenge = await sha256Base64url(verifier);

  // sessionStorage survives the GitHub redirect round-trip (same origin on the
  // way back) but doesn't outlive the tab — limits stale-verifier replay.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(RETURN_KEY, returnTo || location.href);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  location.assign(`https://github.com/login/oauth/authorize?${params}`);
}

export async function handleCallback() {
  const params = new URLSearchParams(location.search);
  const code   = params.get('code');
  const state  = params.get('state');
  const err    = params.get('error');
  if (err)   throw new Error(params.get('error_description') || err);
  if (!code) throw new Error('Missing code in callback URL');

  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!expectedState || state !== expectedState) {
    throw new Error('State mismatch — possible CSRF, aborting');
  }
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('Missing PKCE verifier — start sign-in again');
  const returnTo = sessionStorage.getItem(RETURN_KEY) || 'index.html';

  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(RETURN_KEY);

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  if (!data.access_token) throw new Error('No access_token in response');

  localStorage.setItem(TOKEN_KEY, data.access_token);
  return returnTo;
}
