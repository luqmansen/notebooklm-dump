// Cross-device progress sync via a private GitHub gist.
//
// Storage shape (one gist file, JSON):
//   { "<trackId>": { "pos": 123.4, "dur": 567.8, "done": false,
//                    "updatedAt": "2026-05-16T12:34:56.789Z" }, ... }
//
// Conflict model: last-write-wins per gist (the whole file is replaced on
// each PATCH). Realistic risk: two devices write within a few seconds of each
// other and one clobbers the other. Accepted — worst case is a few-second
// rewind on the loser. See [[project-oauth-token-cors]] for the auth path.
//
// Write cadence: 3-second debounce during continuous playback, plus immediate
// flush on pause / ended / seeked / visibility-hidden / pagehide. Worst case
// is ~1,200 writes/hour on non-stop listening, well under the 5,000/hour
// authenticated REST limit and the secondary "one mutation per second"
// threshold.

import { getToken } from './auth.js';

const GIST_FILENAME    = 'notebooklm-dump-progress.json';
const GIST_DESCRIPTION = 'notebooklm-dump player progress';
const GIST_ID_KEY      = 'progress_gist_id';
const DEBOUNCE_MS      = 3000;

const POS_KEY     = (id) => `pos:${id}`;
const DONE_KEY    = (id) => `done:${id}`;
const DUR_KEY     = (id) => `dur:${id}`;
const UPDATED_KEY = (id) => `updated:${id}`;

let state         = {};         // { trackId: { pos, dur, done, updatedAt } }
const dirty       = new Set();  // trackIds with unsynced changes
let debounceTimer = null;
let writeInFlight = null;
let initialized   = false;
let gistId        = null;
let onRemoteChange = null;      // optional callback when init pulls remote → local

function ghHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

function readLocal(id) {
  const pos  = parseFloat(localStorage.getItem(POS_KEY(id))  || '0') || 0;
  const dur  = parseFloat(localStorage.getItem(DUR_KEY(id))  || '0') || 0;
  const done = localStorage.getItem(DONE_KEY(id)) === '1';
  return { pos, dur, done };
}

// Mirrors player.js's three localStorage keys. Note: an active pos overrides
// done (same rule player.js uses — see RESUME_THRESHOLD logic) so we only set
// done when pos is zero.
function writeLocal(id, entry) {
  if (entry.pos > 0) {
    localStorage.setItem(POS_KEY(id), String(entry.pos));
    localStorage.removeItem(DONE_KEY(id));
  } else {
    localStorage.removeItem(POS_KEY(id));
    if (entry.done) localStorage.setItem(DONE_KEY(id), '1');
    else localStorage.removeItem(DONE_KEY(id));
  }
  if (entry.dur > 0) localStorage.setItem(DUR_KEY(id), String(entry.dur));
}

function localUpdatedAt(id) {
  return parseInt(localStorage.getItem(UPDATED_KEY(id)) || '0', 10) || 0;
}

function scanLocalIds() {
  const ids = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if      (k.startsWith('pos:'))  ids.add(k.slice(4));
    else if (k.startsWith('done:')) ids.add(k.slice(5));
    else if (k.startsWith('dur:'))  ids.add(k.slice(4));
  }
  return ids;
}

async function findOrCreateGist(token) {
  const cached = localStorage.getItem(GIST_ID_KEY);
  if (cached) {
    const r = await fetch(`https://api.github.com/gists/${cached}`, { headers: ghHeaders(token) });
    if (r.ok) return cached;
    if (r.status === 404) localStorage.removeItem(GIST_ID_KEY);
    else throw new Error(`gist probe ${r.status}`);
  }

  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://api.github.com/gists?per_page=100&page=${page}`, { headers: ghHeaders(token) });
    if (!r.ok) throw new Error(`list gists ${r.status}`);
    const list = await r.json();
    if (list.length === 0) break;
    const found = list.find(g => g.description === GIST_DESCRIPTION && g.files && g.files[GIST_FILENAME]);
    if (found) {
      localStorage.setItem(GIST_ID_KEY, found.id);
      return found.id;
    }
    if (list.length < 100) break;
  }

  const r = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: '{}' } },
    }),
  });
  if (!r.ok) throw new Error(`create gist ${r.status}: ${await r.text()}`);
  const data = await r.json();
  localStorage.setItem(GIST_ID_KEY, data.id);
  return data.id;
}

async function readGist(token, id) {
  const r = await fetch(`https://api.github.com/gists/${id}`, { headers: ghHeaders(token) });
  if (!r.ok) throw new Error(`read gist ${r.status}`);
  const data = await r.json();
  const file = data.files && data.files[GIST_FILENAME];
  if (!file) return {};
  let content = file.content || '';
  // Files >1 MB get truncated in the gist API response; fetch the raw URL instead.
  if (file.truncated && file.raw_url) {
    const rr = await fetch(file.raw_url);
    if (rr.ok) content = await rr.text();
  }
  try {
    const parsed = JSON.parse(content);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

async function writeGist(token, id, content, opts = {}) {
  const r = await fetch(`https://api.github.com/gists/${id}`, {
    method: 'PATCH',
    headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      files: { [GIST_FILENAME]: { content: JSON.stringify(content) } },
    }),
    // keepalive lets the request survive pagehide/unload. 64 KB body cap on the
    // browser side, well above a realistic progress blob (~100 B per track).
    keepalive: !!opts.keepalive,
  });
  if (!r.ok) throw new Error(`write gist ${r.status}`);
}

// Reconcile remote ↔ local on sign-in / page load.
//
// Per-track resolution:
//   • only remote     → write to local
//   • only local      → keep, mark dirty (push on first flush)
//   • both, remote newer → remote wins (overwrite local)
//   • both, local newer  → keep local, mark dirty
//   • both, tied      → keep local (no work)
//
// Pre-existing local entries from before this feature have updatedAt=0, so any
// remote entry beats them. That's intentional: if you sync from a device that
// already has the gist populated, that gist is authoritative.
function reconcile(remote) {
  const localIds = scanLocalIds();
  const allIds   = new Set([...Object.keys(remote), ...localIds]);
  const merged   = {};
  let touchedLocal = false;

  for (const id of allIds) {
    const hasLocal  = localIds.has(id);
    const hasRemote = Object.prototype.hasOwnProperty.call(remote, id);
    const localData = hasLocal ? readLocal(id) : null;
    const localTs   = localUpdatedAt(id);
    const remoteEntry = hasRemote ? remote[id] : null;
    const remoteTs    = remoteEntry ? (Date.parse(remoteEntry.updatedAt) || 0) : 0;

    if (hasRemote && !hasLocal) {
      writeLocal(id, remoteEntry);
      localStorage.setItem(UPDATED_KEY(id), String(remoteTs));
      merged[id] = remoteEntry;
      touchedLocal = true;
    } else if (hasLocal && !hasRemote) {
      const ts = localTs || Date.now();
      if (!localTs) localStorage.setItem(UPDATED_KEY(id), String(ts));
      merged[id] = { ...localData, updatedAt: new Date(ts).toISOString() };
      dirty.add(id);
    } else if (remoteTs > localTs) {
      writeLocal(id, remoteEntry);
      localStorage.setItem(UPDATED_KEY(id), String(remoteTs));
      merged[id] = remoteEntry;
      touchedLocal = true;
    } else {
      merged[id] = { ...localData, updatedAt: new Date(localTs).toISOString() };
      if (localTs > remoteTs) dirty.add(id);
    }
  }
  state = merged;
  return touchedLocal;
}

export function setOnRemoteChange(cb) {
  onRemoteChange = cb;
}

// Returns true if remote data was applied to local (caller should re-render).
export async function init() {
  const token = getToken();
  if (!token) return false;
  try {
    gistId = await findOrCreateGist(token);
    const remote = await readGist(token, gistId);
    const touched = reconcile(remote);
    initialized = true;
    if (dirty.size > 0) scheduleFlush();
    if (touched && typeof onRemoteChange === 'function') {
      try { onRemoteChange(); } catch (e) { console.error('onRemoteChange threw:', e); }
    }
    return touched;
  } catch (e) {
    console.error('sync.init failed:', e);
    return false;
  }
}

// Called from player.js save sites whenever pos/dur/done changes locally.
// Reads the fresh localStorage values, stamps updatedAt, and schedules a flush.
export function markDirty(id) {
  if (!initialized) return;
  const now = Date.now();
  const local = readLocal(id);
  state[id] = { ...local, updatedAt: new Date(now).toISOString() };
  localStorage.setItem(UPDATED_KEY(id), String(now));
  dirty.add(id);
  scheduleFlush();
}

function scheduleFlush() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flush().catch(e => console.error('sync flush error:', e));
  }, DEBOUNCE_MS);
}

export async function flush(opts = {}) {
  if (!initialized || dirty.size === 0) return;
  if (writeInFlight) return writeInFlight;
  const token = getToken();
  if (!token || !gistId) return;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }

  dirty.clear();
  const snapshot = state;

  writeInFlight = (async () => {
    try {
      await writeGist(token, gistId, snapshot, opts);
    } catch (e) {
      console.error('sync write failed:', e);
    } finally {
      writeInFlight = null;
      if (dirty.size > 0) scheduleFlush();
    }
  })();
  return writeInFlight;
}

// Best-effort flush on tab close / hide. keepalive lets the PATCH survive the
// page lifecycle event. Browsers may still cancel — accept the loss.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush({ keepalive: true });
});
window.addEventListener('pagehide',     () => flush({ keepalive: true }));
window.addEventListener('beforeunload', () => flush({ keepalive: true }));
