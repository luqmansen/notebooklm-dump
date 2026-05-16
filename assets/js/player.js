const POS_KEY = (id) => `pos:${id}`;
const RESUME_THRESHOLD_SEC = 5;

// Fetch tracks.json via the GitHub Contents API instead of raw.githubusercontent.com.
// raw.* sits behind Fastly which ignores query-string cache busters (verified empirically) —
// you can wait up to 5 minutes for an edit to propagate. The Contents API has no
// Fastly cache, only a 60s client-side max-age which `cache: 'no-store'` defeats.
// Costs one request from the 60-per-hour-per-IP unauthenticated rate limit; fine for
// personal use. Falls back to Pages-served tracks.json if rate-limited or offline.
const TRACKS_CONTENTS_API = 'https://api.github.com/repos/luqmansen/notebooklm-dump/contents/tracks.json';
const TRACKS_FALLBACK_URL = 'tracks.json'; // Pages-served — older but available offline

const $tracks  = document.getElementById('tracks');
const $audio   = document.getElementById('player');
const $np      = document.getElementById('now-playing');
const $title   = document.getElementById('np-title');
const $artist  = document.getElementById('np-artist');
const $resume  = document.getElementById('resume');

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

  renderList();
  cleanupStalePositions();
}

function renderList() {
  $tracks.innerHTML = '';
  for (const t of catalog) {
    const li = document.createElement('li');
    li.className = 'track';
    li.dataset.id = t.id;
    li.innerHTML = `<div class="track-title"></div>`;
    li.querySelector('.track-title').textContent = t.title;
    if (t.artist) {
      const artist = document.createElement('div');
      artist.className = 'track-artist';
      artist.textContent = t.artist;
      li.appendChild(artist);
    }
    li.addEventListener('click', () => selectTrack(t));
    $tracks.appendChild(li);
  }
}

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
  const now = Date.now();
  if (now - lastWrite < 3000) return;
  lastWrite = now;
  const t = $audio.currentTime;
  if (t > RESUME_THRESHOLD_SEC && t < ($audio.duration - RESUME_THRESHOLD_SEC)) {
    localStorage.setItem(POS_KEY(active.id), String(t));
  }
});

$audio.addEventListener('ended', () => {
  if (active) localStorage.removeItem(POS_KEY(active.id));
});

function cleanupStalePositions() {
  const validIds = new Set(catalog.map(t => t.id));
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('pos:')) {
      const id = key.slice(4);
      if (!validIds.has(id)) localStorage.removeItem(key);
    }
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
