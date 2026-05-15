// ---------- config ----------
const OWNER = 'luqmansen';
const REPO  = 'notebooklm-dump';
const PAT_KEY = 'gh_pat';

// Cloudflare Worker proxy for browser → uploads.github.com.
const UPLOAD_PROXY_BASE = 'https://notebooklm-upload.luqmansen.workers.dev/';

// 100 MB Worker free-tier cap. Files larger than this are transcoded in-browser
// via ffmpeg.wasm to fit under the limit (with a small safety margin).
const WORKER_MAX_BYTES = 100 * 1024 * 1024;
const TRANSCODE_TARGET_BYTES = 95 * 1024 * 1024;   // aim slightly under
const TRANSCODE_MIN_KBPS = 32;                     // floor for speech
const TRANSCODE_MAX_KBPS = 96;                     // ceiling — voice doesn't need more
const HARD_MAX_BYTES = 2 * 1024 * 1024 * 1024;     // GitHub release asset hard cap

const CONCURRENCY = 3; // parallel upload pipelines (transcode is always serial)

// ---------- DOM ----------
const $authCard   = document.getElementById('auth-card');
const $uploadCard = document.getElementById('upload-card');
const $patInput   = document.getElementById('pat');
const $authBtn    = document.getElementById('auth-btn');
const $authStatus = document.getElementById('auth-status');

const $file        = document.getElementById('file');
const $queue       = document.getElementById('queue');
const $uploadBtn   = document.getElementById('upload-btn');
const $clearBtn    = document.getElementById('clear-btn');
const $logoutBtn   = document.getElementById('logout-btn');
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
  return btoa(unescape(encodeURIComponent(str)));
}

function titleizeFromFilename(name) {
  const noExt = name.replace(/\.[^.]+$/, '');
  const spaced = noExt.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.split(' ').map(w => {
    if (!w) return w;
    if (/[A-Z]/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// ---------- auth ----------
async function validatePat(token) {
  const res = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`PAT rejected (${res.status})`);
  const u = await res.json();
  return u.login;
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
  resetQueue();
}

$authBtn.addEventListener('click', async () => {
  const token = $patInput.value.trim();
  if (!token) return setStatus($authStatus, 'Paste a token first.', 'err');
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

// ---------- queue model ----------
let queue = [];
let isUploading = false;

function resetQueue() {
  queue = [];
  renderQueue();
}

function nextTrackId() {
  const rnd = Math.random().toString(36).slice(2, 5);
  return `track-${Date.now().toString(36)}-${rnd}`;
}

function addFilesToQueue(files) {
  for (const f of files) {
    queue.push({
      id: nextTrackId(),
      file: f,
      transcodedFile: null,
      title: titleizeFromFilename(f.name),
      status: 'pending',
      progress: 0,
      error: null,
    });
  }
  renderQueue();
}

function renderQueue() {
  $queue.innerHTML = '';
  if (queue.length === 0) {
    $queue.innerHTML = '<div class="queue-empty">No files queued. Pick files above to start.</div>';
    $uploadBtn.disabled = true;
    $clearBtn.disabled = true;
    return;
  }
  $uploadBtn.disabled = isUploading;
  $clearBtn.disabled = isUploading;

  for (const item of queue) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.dataset.id = item.id;

    const top = document.createElement('div');
    top.className = 'queue-item-top';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'queue-title-input';
    titleInput.value = item.title;
    titleInput.placeholder = 'Title';
    titleInput.disabled = isUploading || item.status === 'done';
    titleInput.addEventListener('input', e => { item.title = e.target.value; });

    const remove = document.createElement('button');
    remove.className = 'queue-remove';
    remove.textContent = '×';
    remove.title = 'Remove from queue';
    remove.disabled = isUploading;
    remove.addEventListener('click', () => {
      queue = queue.filter(q => q.id !== item.id);
      renderQueue();
    });

    top.append(titleInput, remove);

    const meta = document.createElement('div');
    meta.className = 'queue-meta';
    const size = document.createElement('span');
    size.textContent = fmtBytes(item.file.size) + (item.file.size > WORKER_MAX_BYTES ? ' (will re-encode)' : '');
    const status = document.createElement('span');
    status.className = `queue-status ${statusKind(item.status)}`;
    status.textContent = statusLabel(item);
    meta.append(size, status);

    const progress = document.createElement('div');
    progress.className = 'progress';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.style.width = `${item.progress * 100}%`;
    progress.appendChild(bar);

    row.append(top, meta, progress);

    item.row = row;
    item.titleInput = titleInput;
    item.progressBar = bar;
    item.statusEl = status;
    item.sizeEl = size;

    $queue.appendChild(row);
  }
}

function statusKind(s) {
  if (s === 'done')    return 'ok';
  if (s === 'failed')  return 'err';
  if (s === 'pending') return '';
  return 'warn';
}

function statusLabel(item) {
  switch (item.status) {
    case 'pending':            return '⏳ Pending';
    case 'transcode_waiting':  return '⏳ Waiting for transcode lock...';
    case 'transcoding':        return `⚙️ Transcoding ${(item.progress * 100).toFixed(0)}%`;
    case 'creating_release':   return '→ Creating release...';
    case 'uploading':          return `↑ Uploading ${(item.progress * 100).toFixed(0)}%`;
    case 'done':               return '✓ Done';
    case 'failed':             return `✗ ${item.error || 'failed'}`;
    default:                   return item.status;
  }
}

function updateItem(item, patch) {
  Object.assign(item, patch);
  if (item.statusEl) {
    item.statusEl.textContent = statusLabel(item);
    item.statusEl.className = `queue-status ${statusKind(item.status)}`;
  }
  if (item.progressBar) {
    item.progressBar.style.width = `${item.progress * 100}%`;
  }
}

// ---------- file picker ----------
$file.addEventListener('change', () => {
  if (isUploading) return;
  const files = Array.from($file.files || []);
  if (files.length === 0) return;
  addFilesToQueue(files);
  $file.value = '';
});

$clearBtn.addEventListener('click', () => {
  if (isUploading) return;
  resetQueue();
});

// ---------- ffmpeg.wasm: lazy load, serialized transcodes ----------
// Uses the UMD distribution loaded via <script> in upload.html. The UMD build
// uses a classic (non-module) Worker for its internal worker.js, which is what
// makes cross-origin loading from jsdelivr work. The ESM build forces a module
// worker which can't be spawned from a cross-origin Blob URL.
let ffmpegInstancePromise = null;
let transcodeLock = Promise.resolve();

async function getFFmpeg() {
  if (ffmpegInstancePromise) return ffmpegInstancePromise;
  ffmpegInstancePromise = (async () => {
    if (!window.FFmpegWASM || !window.FFmpegUtil) {
      throw new Error('ffmpeg.wasm UMD scripts not loaded — check the <script> tags in upload.html');
    }
    const { FFmpeg } = window.FFmpegWASM;
    const { fetchFile } = window.FFmpegUtil;
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
      wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm',
    });
    return { ffmpeg, fetchFile };
  })();
  return ffmpegInstancePromise;
}

async function probeDurationSeconds(file) {
  const url = URL.createObjectURL(file);
  try {
    const audio = new Audio(url);
    return await new Promise((resolve, reject) => {
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', () => resolve(audio.duration), { once: true });
      audio.addEventListener('error', () => reject(new Error('cannot probe duration')), { once: true });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function transcodeForUpload(item) {
  updateItem(item, { status: 'transcode_waiting', progress: 0 });
  const prev = transcodeLock;
  let release;
  transcodeLock = new Promise(r => release = r);
  await prev;

  try {
    updateItem(item, { status: 'transcoding', progress: 0 });
    const { ffmpeg, fetchFile } = await getFFmpeg();

    const durationSec = await probeDurationSeconds(item.file);
    if (!isFinite(durationSec) || durationSec <= 0) {
      throw new Error('could not probe duration to pick bitrate');
    }
    let targetKbps = Math.floor(TRANSCODE_TARGET_BYTES * 8 / durationSec / 1000);
    if (targetKbps > TRANSCODE_MAX_KBPS) targetKbps = TRANSCODE_MAX_KBPS;
    if (targetKbps < TRANSCODE_MIN_KBPS) targetKbps = TRANSCODE_MIN_KBPS;

    const inName  = `in_${item.id}`;
    const outName = `out_${item.id}.m4a`;

    await ffmpeg.writeFile(inName, await fetchFile(item.file));

    const progressHandler = ({ progress }) => {
      updateItem(item, { progress: Math.max(0, Math.min(1, progress)) });
    };
    ffmpeg.on('progress', progressHandler);

    try {
      await ffmpeg.exec([
        '-i', inName,
        '-vn',                        // drop any video track
        '-c:a', 'aac',
        '-b:a', `${targetKbps}k`,
        '-movflags', '+faststart',    // playable while streaming
        outName,
      ]);
    } finally {
      ffmpeg.off('progress', progressHandler);
    }

    const data = await ffmpeg.readFile(outName);
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});

    const newName = item.file.name.replace(/(\.[^./]+)?$/, '.m4a');
    const newFile = new File([data], newName, { type: 'audio/mp4' });

    if (newFile.size > WORKER_MAX_BYTES) {
      throw new Error(`transcoded file is still ${fmtBytes(newFile.size)} (over 100 MB) — source too long even at ${TRANSCODE_MIN_KBPS} kbps`);
    }

    item.transcodedFile = newFile;
    if (item.sizeEl) item.sizeEl.textContent = `${fmtBytes(item.file.size)} → ${fmtBytes(newFile.size)} @ ${targetKbps}kbps`;
    updateItem(item, { progress: 1 });
  } finally {
    release();
  }
}

// ---------- GitHub API calls ----------
async function createRelease(token, trackId, title) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
    {
      method: 'POST',
      headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        tag_name: trackId,
        name: title || trackId,
        body: `Audio asset for "${title}".`,
      }),
    }
  );
  if (!res.ok) throw new Error(`createRelease ${res.status}: ${await res.text()}`);
  return res.json();
}

async function deleteRelease(token, releaseId) {
  await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}`, {
    method: 'DELETE',
    headers: ghHeaders(token),
  });
}

function uploadAsset(release, file, token, onProgress) {
  const base = UPLOAD_PROXY_BASE.replace(/\/$/, '');
  const params = new URLSearchParams({
    owner: OWNER,
    repo: REPO,
    release_id: String(release.id),
    name: file.name,
  });
  const url = `${base}/?${params}`;

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
        reject(new Error(`upload ${xhr.status}: ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error('upload network error — check Worker is reachable'));
    xhr.send(file);
  });
}

async function batchAppendTracks(token, entries) {
  if (entries.length === 0) return;
  const path = `repos/${OWNER}/${REPO}/contents/tracks.json`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const getRes = await fetch(`https://api.github.com/${path}`, { headers: ghHeaders(token) });
    if (!getRes.ok) throw new Error(`get tracks.json ${getRes.status}`);
    const meta = await getRes.json();
    let list;
    try {
      list = JSON.parse(atob(meta.content.replace(/\n/g, '')));
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
    list.push(...entries);

    const msg = entries.length === 1
      ? `library: add ${entries[0].id}`
      : `library: add ${entries.length} tracks`;

    const putRes = await fetch(`https://api.github.com/${path}`, {
      method: 'PUT',
      headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: msg,
        content: base64FromString(JSON.stringify(list, null, 2) + '\n'),
        sha: meta.sha,
      }),
    });
    if (putRes.ok) return;
    if (putRes.status === 409 && attempt < 2) {
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
      continue;
    }
    throw new Error(`put tracks.json ${putRes.status}: ${await putRes.text()}`);
  }
}

// ---------- per-file pipeline ----------
async function pipeline(item, token) {
  try {
    // 1. Transcode if needed (serialized via transcodeLock)
    if (item.file.size > WORKER_MAX_BYTES) {
      await transcodeForUpload(item);
    }
    const fileToUpload = item.transcodedFile || item.file;

    // 2. Create release
    updateItem(item, { status: 'creating_release', progress: 0 });
    const release = await createRelease(token, item.id, item.title);

    // 3. Upload through Worker
    updateItem(item, { status: 'uploading', progress: 0 });
    let asset;
    try {
      asset = await uploadAsset(release, fileToUpload, token, (pct) => {
        updateItem(item, { progress: pct });
      });
    } catch (e) {
      // Don't leave an empty release behind
      await deleteRelease(token, release.id).catch(() => {});
      throw e;
    }

    updateItem(item, { status: 'done', progress: 1 });
    return {
      ok: true,
      entry: { id: item.id, title: item.title, url: asset.browser_download_url },
    };
  } catch (e) {
    console.error(`pipeline failed for ${item.id}:`, e);
    updateItem(item, { status: 'failed', error: e.message });
    return { ok: false, error: e.message };
  }
}

// ---------- bounded parallel runner ----------
async function runQueue(token) {
  const items = queue.filter(q => q.status === 'pending');
  if (items.length === 0) return [];

  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      results.push(await pipeline(item, token));
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------- main click handler ----------
$uploadBtn.addEventListener('click', async () => {
  const token = localStorage.getItem(PAT_KEY);
  if (!token)             return setStatus($uploadStatus, 'Not authenticated.', 'err');
  if (queue.length === 0) return setStatus($uploadStatus, 'No files queued.', 'err');

  for (const item of queue) {
    if (item.file.size > HARD_MAX_BYTES) {
      return setStatus($uploadStatus, `${item.file.name} is ${fmtBytes(item.file.size)}, exceeds GitHub's 2 GB release-asset limit.`, 'err');
    }
    if (!item.title.trim()) {
      return setStatus($uploadStatus, `${item.file.name} has no title.`, 'err');
    }
  }

  isUploading = true;
  $uploadBtn.disabled = true;
  $clearBtn.disabled = true;
  $logoutBtn.disabled = true;
  $file.disabled = true;
  for (const item of queue) {
    if (item.titleInput) item.titleInput.disabled = true;
  }
  window.addEventListener('beforeunload', warnUnload);
  setStatus($uploadStatus, `Processing ${queue.length} file(s), up to ${CONCURRENCY} uploads in parallel...`);

  try {
    const results = await runQueue(token);
    const okEntries = results.filter(r => r.ok).map(r => r.entry);
    const failed = results.filter(r => !r.ok);

    if (okEntries.length > 0) {
      setStatus($uploadStatus, 'Uploads done. Updating library index...');
      await batchAppendTracks(token, okEntries);
    }

    const summary = `Done. ${okEntries.length} succeeded, ${failed.length} failed.` +
      (okEntries.length > 0 ? ` <a href="index.html" style="color:var(--accent);">View library →</a>` : '');
    setStatus($uploadStatus, summary, failed.length === 0 ? 'ok' : 'warn');
  } catch (e) {
    console.error(e);
    setStatus($uploadStatus, `Batch failed: ${e.message}`, 'err');
  } finally {
    isUploading = false;
    $logoutBtn.disabled = false;
    $file.disabled = false;
    renderQueue();
    window.removeEventListener('beforeunload', warnUnload);
  }
});

function warnUnload(e) { e.preventDefault(); e.returnValue = ''; }

// ---------- bootstrap ----------
(function init() {
  const stored = localStorage.getItem(PAT_KEY);
  if (!stored) return showLocked();
  validatePat(stored)
    .then(() => showUnlocked())
    .catch(() => {
      localStorage.removeItem(PAT_KEY);
      showLocked();
      setStatus($authStatus, 'Stored token is invalid or expired.', 'err');
    });
})();
