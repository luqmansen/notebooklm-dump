// ---------- config ----------
const OWNER = 'luqmansen';
const REPO  = 'notebooklm-dump';
const PAT_KEY = 'gh_pat';
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB release-asset cap

// Cloudflare Worker upload proxy. Required because uploads.github.com does not
// send CORS headers — see worker.js for the proxy code and README for deploy steps.
// Leave empty to attempt direct upload (will fail with a CORS error in the browser).
const UPLOAD_PROXY_BASE = ''; // e.g. 'https://notebooklm-upload.<sub>.workers.dev'

// ---------- DOM ----------
const $authCard   = document.getElementById('auth-card');
const $uploadCard = document.getElementById('upload-card');
const $patInput   = document.getElementById('pat');
const $authBtn    = document.getElementById('auth-btn');
const $authStatus = document.getElementById('auth-status');

const $file        = document.getElementById('file');
const $title       = document.getElementById('title');
const $uploadBtn   = document.getElementById('upload-btn');
const $logoutBtn   = document.getElementById('logout-btn');
const $progressWrap = document.getElementById('progress-wrap');
const $progressBar  = document.getElementById('progress-bar');
const $uploadStatus = document.getElementById('upload-status');

// ---------- helpers ----------
function setStatus(el, msg, kind) {
  const cls = kind ? ` class="${kind}"` : '';
  el.innerHTML = msg ? `<span${cls}>${msg}</span>` : '';
}

function ghHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function base64FromString(str) {
  // tracks.json is small; this is safe.
  return btoa(unescape(encodeURIComponent(str)));
}

function titleizeFromFilename(name) {
  const noExt = name.replace(/\.[^.]+$/, '');
  const spaced = noExt.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.split(' ').map(w => {
    if (!w) return w;
    if (/[A-Z]/.test(w)) return w; // preserve internal capitals (MapReduce, etc.)
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

let titleManuallyEdited = false;
$title.addEventListener('input', () => { titleManuallyEdited = true; });
$file.addEventListener('change', () => {
  const f = $file.files[0];
  if (!f) return;
  if (!titleManuallyEdited || !$title.value.trim()) {
    $title.value = titleizeFromFilename(f.name);
    titleManuallyEdited = false;
  }
});

// ---------- auth ----------
async function validatePat(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: ghHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`PAT rejected (${res.status})`);
  }
  const user = await res.json();
  return user.login;
}

function showUnlocked() {
  $authCard.classList.add('hidden');
  $uploadCard.classList.remove('hidden');
}

function showLocked() {
  $authCard.classList.remove('hidden');
  $uploadCard.classList.add('hidden');
  $patInput.value = '';
  setStatus($authStatus, '');
  setStatus($uploadStatus, '');
}

$authBtn.addEventListener('click', async () => {
  const token = $patInput.value.trim();
  if (!token) {
    setStatus($authStatus, 'Paste a token first.', 'err');
    return;
  }
  $authBtn.disabled = true;
  setStatus($authStatus, 'Validating...');
  try {
    const user = await validatePat(token);
    localStorage.setItem(PAT_KEY, token);
    setStatus($authStatus, `Authenticated as ${user}.`, 'ok');
    setTimeout(showUnlocked, 400);
  } catch (e) {
    setStatus($authStatus, e.message, 'err');
  } finally {
    $authBtn.disabled = false;
  }
});

$logoutBtn.addEventListener('click', () => {
  localStorage.removeItem(PAT_KEY);
  showLocked();
});

// ---------- upload pipeline ----------
async function createRelease(token, trackId, title) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
    {
      method: 'POST',
      headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        tag_name: trackId,
        name: title || trackId,
        body: `Audio asset for "${title}". Uploaded via upload.html.`,
      }),
    }
  );
  if (!res.ok) throw new Error(`createRelease failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function uploadAsset(release, file, token, onProgress) {
  let url;
  if (UPLOAD_PROXY_BASE) {
    const params = new URLSearchParams({
      owner: OWNER,
      repo: REPO,
      release_id: String(release.id),
      name: file.name,
    });
    url = `${UPLOAD_PROXY_BASE.replace(/\/$/, '')}/?${params}`;
  } else {
    // Direct (will fail with CORS in the browser; kept as a fallback path).
    const cleaned = release.upload_url.replace(/\{[^}]*\}$/, '');
    url = `${cleaned}?name=${encodeURIComponent(file.name)}`;
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'audio/mp4');
    xhr.setRequestHeader('Accept', 'application/vnd.github+json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`uploadAsset failed: ${xhr.status} ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error(
      UPLOAD_PROXY_BASE
        ? 'uploadAsset network error — check Worker is deployed and reachable'
        : 'uploadAsset blocked by CORS — set UPLOAD_PROXY_BASE in uploader.js (see README)'
    ));
    xhr.send(file);
  });
}

async function appendTrack(token, entry) {
  const path = `repos/${OWNER}/${REPO}/contents/tracks.json`;
  const getRes = await fetch(`https://api.github.com/${path}`, {
    headers: ghHeaders(token),
  });
  if (!getRes.ok) throw new Error(`get tracks.json failed: ${getRes.status}`);
  const meta = await getRes.json();
  const decoded = atob(meta.content.replace(/\n/g, ''));
  let list;
  try {
    list = JSON.parse(decoded);
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list.push(entry);

  const putRes = await fetch(`https://api.github.com/${path}`, {
    method: 'PUT',
    headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: `library: add ${entry.id}`,
      content: base64FromString(JSON.stringify(list, null, 2) + '\n'),
      sha: meta.sha,
    }),
  });
  if (!putRes.ok) throw new Error(`put tracks.json failed: ${putRes.status} ${await putRes.text()}`);
  return putRes.json();
}

// ---------- main click handler ----------
$uploadBtn.addEventListener('click', async () => {
  const token  = localStorage.getItem(PAT_KEY);
  const file   = $file.files[0];
  const title  = $title.value.trim();

  if (!token)         return setStatus($uploadStatus, 'Not authenticated.', 'err');
  if (!file)          return setStatus($uploadStatus, 'Pick a file first.', 'err');
  if (!title)         return setStatus($uploadStatus, 'Title is required.', 'err');
  if (file.size > MAX_BYTES) {
    return setStatus($uploadStatus, `File is ${fmtBytes(file.size)}, exceeds 2 GB release-asset limit.`, 'err');
  }

  const trackId = `track-${Date.now().toString(36)}`;
  $uploadBtn.disabled = true;
  $logoutBtn.disabled = true;
  window.addEventListener('beforeunload', warnUnload);

  try {
    setStatus($uploadStatus, `1/3 Creating release ${trackId}...`);
    const release = await createRelease(token, trackId, title);

    setStatus($uploadStatus, `2/3 Uploading ${fmtBytes(file.size)}...`);
    $progressWrap.classList.remove('hidden');
    const asset = await uploadAsset(release, file, token, (pct) => {
      $progressBar.style.width = `${(pct * 100).toFixed(1)}%`;
    });

    setStatus($uploadStatus, '3/3 Updating tracks.json...');
    const entry = {
      id: trackId,
      title,
      url: asset.browser_download_url,
    };
    await appendTrack(token, entry);

    setStatus($uploadStatus,
      `Done. <a href="index.html" style="color:var(--accent);">View in library →</a>` +
      `\n(Pages rebuild takes ~30–60 s before the player reflects the change.)`,
      'ok');
    $file.value = '';
    $title.value = '';
    titleManuallyEdited = false;
  } catch (e) {
    console.error(e);
    setStatus($uploadStatus, `Failed: ${e.message}`, 'err');
  } finally {
    $uploadBtn.disabled = false;
    $logoutBtn.disabled = false;
    window.removeEventListener('beforeunload', warnUnload);
  }
});

function warnUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}

// ---------- bootstrap ----------
(function init() {
  const stored = localStorage.getItem(PAT_KEY);
  if (!stored) {
    showLocked();
    return;
  }
  // Verify the stored token still works.
  validatePat(stored)
    .then(() => showUnlocked())
    .catch(() => {
      localStorage.removeItem(PAT_KEY);
      showLocked();
      setStatus($authStatus, 'Stored token is invalid or expired.', 'err');
    });
})();
