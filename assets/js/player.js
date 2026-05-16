const POS_KEY  = (id) => `pos:${id}`;
const DONE_KEY = (id) => `done:${id}`;
const DUR_KEY  = (id) => `dur:${id}`;   // cached so list can show % without loading audio
const RESUME_THRESHOLD_SEC = 5;

// Fetch tracks.json via the GitHub Contents API instead of raw.githubusercontent.com.
// raw.* sits behind Fastly which ignores query-string cache busters (verified empirically) —
// you can wait up to 5 minutes for an edit to propagate. The Contents API has no
// Fastly cache, only a 60s client-side max-age which `cache: 'no-store'` defeats.
// Costs one request from the 60-per-hour-per-IP unauthenticated rate limit; fine for
// personal use. Falls back to Pages-served tracks.json if rate-limited or offline.
const TRACKS_CONTENTS_API = 'https://api.github.com/repos/luqmansen/notebooklm-dump/contents/tracks.json';
const TRACKS_FALLBACK_URL = 'tracks.json'; // Pages-served — older but available offline

const $tracks    = document.getElementById('tracks');
const $audio     = document.getElementById('player');
const $np        = document.getElementById('now-playing');
const $title     = document.getElementById('np-title');
const $artist    = document.getElementById('np-artist');
const $resume    = document.getElementById('resume');
const $search    = document.getElementById('search');
const $tagFilter = document.getElementById('tag-filter');

let plyr = null;
let active = null;       // current track object
let catalog = [];        // full tracks.json
let lastWrite = 0;

function fmt(t) {
  if (!isFinite(t)) return '?';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function loadCatalog() {
  catalog = [];

  // 1. Try Contents API for fresh data.
  try {
    const res = await fetch(TRACKS_CONTENTS_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    catalog = JSON.parse(atob(data.content.replace(/\n/g, '')));
  } catch (e) {
    console.warn('Contents API failed, falling back to Pages-served tracks.json:', e);
    // 2. Fall back to the Pages copy.
    try {
      const res = await fetch(`${TRACKS_FALLBACK_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}`);
      catalog = await res.json();
    } catch (e2) {
      console.error('All tracks.json fetches failed:', e2);
    }
  }

  refreshTagFilter();
  renderList();
  cleanupStalePositions();
}

// Active saved position wins over a stale "done" flag — resuming a finished
// track moves it back to in-progress as soon as the listener crosses the
// timeupdate threshold (player.js writes pos:<id> then).
const STATUS_ORDER = { 'in-progress': 0, 'untouched': 1, 'done': 2 };
function trackStatus(id) {
  if (localStorage.getItem(POS_KEY(id)))  return 'in-progress';
  if (localStorage.getItem(DONE_KEY(id))) return 'done';
  return 'untouched';
}

// Returns { pos, dur, pct } where pct is null if duration unknown (track never
// loaded). Falls back to ordering by raw seconds when pct is missing.
function trackProgress(id) {
  const pos = parseFloat(localStorage.getItem(POS_KEY(id)) || '0');
  if (!(pos > 0)) return null;
  const dur = parseFloat(localStorage.getItem(DUR_KEY(id)) || '0');
  return { pos, dur, pct: dur > 0 ? Math.min(1, pos / dur) : null };
}

function refreshTagFilter() {
  const all = new Set();
  for (const t of catalog) {
    if (Array.isArray(t.tags)) for (const tag of t.tags) all.add(tag);
  }
  const selected = $tagFilter.value;
  const sorted = Array.from(all).sort((a, b) => a.localeCompare(b));
  $tagFilter.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All tags';
  $tagFilter.appendChild(allOpt);
  for (const tag of sorted) {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    $tagFilter.appendChild(opt);
  }
  if (sorted.includes(selected)) $tagFilter.value = selected;
}

function visibleTracks() {
  const query = $search.value.trim().toLowerCase();
  const tag   = $tagFilter.value;
  return catalog
    .filter(t => {
      if (query && !t.title.toLowerCase().includes(query)) return false;
      if (tag && !(Array.isArray(t.tags) && t.tags.includes(tag))) return false;
      return true;
    })
    .map(t => ({ t, status: trackStatus(t.id) }))
    .sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (so !== 0) return so;
      // Within the in-progress group, furthest-played first. Pct wins; if
      // duration is unknown for one side, fall back to raw seconds.
      if (a.status === 'in-progress') {
        const pa = trackProgress(a.t.id);
        const pb = trackProgress(b.t.id);
        const va = pa?.pct ?? (pa?.pos ?? 0) / 1e9;
        const vb = pb?.pct ?? (pb?.pos ?? 0) / 1e9;
        return vb - va;
      }
      return 0;
    })
    .map(x => x.t);
}

function renderList() {
  $tracks.innerHTML = '';
  const list = visibleTracks();
  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'tracks-empty';
    empty.textContent = catalog.length === 0
      ? 'No tracks yet. Visit /upload.html to add one.'
      : 'No tracks match your filters.';
    $tracks.appendChild(empty);
    return;
  }
  for (const t of list) {
    const status = trackStatus(t.id);
    const li = document.createElement('li');
    li.className = `track ${status}`;
    li.dataset.id = t.id;
    if (active && active.id === t.id) li.classList.add('active');

    const title = document.createElement('div');
    title.className = 'track-title';
    const dot = document.createElement('span');
    dot.className = `track-status-dot ${status}`;
    dot.title = status === 'in-progress' ? 'In progress' : status === 'done' ? 'Finished' : 'Not started';
    const titleText = document.createElement('span');
    titleText.textContent = t.title;
    title.append(dot, titleText);

    const prog = status === 'in-progress' ? trackProgress(t.id) : null;
    if (prog) {
      const lbl = document.createElement('span');
      lbl.className = 'track-progress-label';
      lbl.textContent = prog.pct !== null
        ? `${Math.round(prog.pct * 100)}%`
        : fmt(prog.pos);
      title.appendChild(lbl);
    }
    li.appendChild(title);

    if (t.artist) {
      const artist = document.createElement('div');
      artist.className = 'track-artist';
      artist.textContent = t.artist;
      li.appendChild(artist);
    }
    if (Array.isArray(t.tags) && t.tags.length > 0) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'track-tags';
      for (const tag of t.tags) {
        const chip = document.createElement('span');
        chip.className = 'track-tag';
        chip.textContent = tag;
        tagsEl.appendChild(chip);
      }
      li.appendChild(tagsEl);
    }
    if (prog && prog.pct !== null) {
      const wrap = document.createElement('div');
      wrap.className = 'track-progress';
      const bar = document.createElement('div');
      bar.className = 'track-progress-bar';
      bar.style.width = `${prog.pct * 100}%`;
      wrap.appendChild(bar);
      li.appendChild(wrap);
    }
    li.addEventListener('click', () => selectTrack(t));
    $tracks.appendChild(li);
  }
}

// Inline-updates the active track's progress bar + label without re-sorting
// the list (avoids items jumping around while the user listens).
function updateActiveProgress() {
  if (!active) return;
  const li = $tracks.querySelector(`.track[data-id="${CSS.escape(active.id)}"]`);
  if (!li) return;
  const dur = isFinite($audio.duration) && $audio.duration > 0
    ? $audio.duration
    : parseFloat(localStorage.getItem(DUR_KEY(active.id)) || '0');
  const pos = $audio.currentTime;
  if (!(pos > 0)) return;
  const pct = dur > 0 ? Math.min(1, pos / dur) : null;

  let label = li.querySelector('.track-progress-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'track-progress-label';
    li.querySelector('.track-title').appendChild(label);
  }
  label.textContent = pct !== null ? `${Math.round(pct * 100)}%` : fmt(pos);

  if (pct !== null) {
    let wrap = li.querySelector('.track-progress');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'track-progress';
      const bar = document.createElement('div');
      bar.className = 'track-progress-bar';
      wrap.appendChild(bar);
      li.appendChild(wrap);
    }
    wrap.firstChild.style.width = `${pct * 100}%`;
  }
}

$search.addEventListener('input', renderList);
$tagFilter.addEventListener('change', renderList);

function selectTrack(track) {
  active = track;
  $np.classList.remove('empty');
  $title.textContent  = track.title;
  $artist.textContent = track.artist || '';
  $artist.style.display = track.artist ? '' : 'none';
  document.querySelectorAll('.track').forEach(el => {
    el.classList.toggle('active', el.dataset.id === track.id);
  });

  $audio.src = track.url;
  $audio.load();

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || '',
    });
  }

  $resume.hidden = true;
  $audio.addEventListener('loadedmetadata', onMetadataReady, { once: true });
}

function updatePositionState() {
  if (!('mediaSession' in navigator)) return;
  if (!isFinite($audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: $audio.duration,
      position: $audio.currentTime,
      playbackRate: $audio.playbackRate,
    });
  } catch { /* some browsers throw if duration changes mid-call */ }
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => $audio.play());
  navigator.mediaSession.setActionHandler('pause', () => $audio.pause());
  navigator.mediaSession.setActionHandler('seekbackward', (e) => {
    $audio.currentTime = Math.max(0, $audio.currentTime - (e.seekOffset || 5));
  });
  navigator.mediaSession.setActionHandler('seekforward', (e) => {
    $audio.currentTime = Math.min($audio.duration || Infinity, $audio.currentTime + (e.seekOffset || 5));
  });
  navigator.mediaSession.setActionHandler('seekto', (e) => {
    if (e.fastSeek && 'fastSeek' in $audio) $audio.fastSeek(e.seekTime);
    else $audio.currentTime = e.seekTime;
    updatePositionState();
  });
  for (const ev of ['loadedmetadata', 'seeked', 'ratechange', 'play', 'pause']) {
    $audio.addEventListener(ev, updatePositionState);
  }
}

function onMetadataReady() {
  if (active && isFinite($audio.duration) && $audio.duration > 0) {
    localStorage.setItem(DUR_KEY(active.id), String($audio.duration));
    updateActiveProgress(); // upgrade any seconds-only label to a percentage
  }
  const saved = parseFloat(localStorage.getItem(POS_KEY(active.id)) || '0');
  if (saved > RESUME_THRESHOLD_SEC && saved < ($audio.duration - RESUME_THRESHOLD_SEC)) {
    promptResume(saved);
  } else {
    $audio.play().catch(() => { /* user-gesture issue, fine */ });
  }
}

function promptResume(sec) {
  $resume.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = `Resume from ${fmt(sec)}?`;
  const btnResume = document.createElement('button');
  btnResume.textContent = 'Resume';
  btnResume.onclick = () => {
    $audio.currentTime = sec;
    $audio.play();
    $resume.hidden = true;
  };
  const btnStart = document.createElement('button');
  btnStart.className = 'secondary';
  btnStart.textContent = 'Start over';
  btnStart.onclick = () => {
    $audio.currentTime = 0;
    $audio.play();
    $resume.hidden = true;
  };
  $resume.append(label, btnResume, btnStart);
  $resume.hidden = false;
}

$audio.addEventListener('timeupdate', () => {
  if (!active) return;
  const t = $audio.currentTime;
  let needsRerender = false;

  // Crossing the resume threshold on a previously-finished track moves it
  // back to in-progress — re-render so it leaves the "done" group.
  if (t > RESUME_THRESHOLD_SEC && localStorage.getItem(DONE_KEY(active.id))) {
    localStorage.removeItem(DONE_KEY(active.id));
    needsRerender = true;
  }

  const now = Date.now();
  if (now - lastWrite >= 3000) {
    lastWrite = now;
    if (t > RESUME_THRESHOLD_SEC && t < ($audio.duration - RESUME_THRESHOLD_SEC)) {
      // First save promotes the track from untouched → in-progress; trigger a
      // re-render so it joins the in-progress group at the top of the list.
      const hadPos = localStorage.getItem(POS_KEY(active.id)) !== null;
      localStorage.setItem(POS_KEY(active.id), String(t));
      if (!hadPos) needsRerender = true;
    }
  }

  if (needsRerender) renderList();
  else updateActiveProgress();
});

$audio.addEventListener('ended', () => {
  if (!active) return;
  localStorage.removeItem(POS_KEY(active.id));
  localStorage.setItem(DONE_KEY(active.id), '1');
  renderList();
});

function cleanupStalePositions() {
  const validIds = new Set(catalog.map(t => t.id));
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key) continue;
    const prefix =
      key.startsWith('pos:')  ? 'pos:'  :
      key.startsWith('done:') ? 'done:' :
      key.startsWith('dur:')  ? 'dur:'  : null;
    if (!prefix) continue;
    const id = key.slice(prefix.length);
    if (!validIds.has(id)) localStorage.removeItem(key);
  }
}

if (typeof Plyr !== 'undefined') {
  plyr = new Plyr($audio, {
    controls: ['rewind', 'play', 'fast-forward', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings'],
    settings: ['speed'],
    speed: { selected: 1, options: [0.75, 1, 1.25, 1.5, 1.75, 2] },
    seekTime: 5,
  });
}

loadCatalog();
