const POS_KEY = (id) => `pos:${id}`;
const RESUME_THRESHOLD_SEC = 5;

// Read tracks.json straight from raw.githubusercontent.com so the library
// reflects the current main branch immediately — no need to wait for a Pages
// rebuild after an upload (~30-60s). raw.githubusercontent.com sends permissive
// CORS headers; the ?_=timestamp param sidesteps Fastly's 5-min edge cache.
const TRACKS_RAW_URL = 'https://raw.githubusercontent.com/luqmansen/notebooklm-dump/main/tracks.json';
const TRACKS_FALLBACK_URL = 'tracks.json'; // Pages-served, in case raw is unreachable

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
  for (const url of [TRACKS_RAW_URL, TRACKS_FALLBACK_URL]) {
    try {
      const res = await fetch(`${url}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}`);
      catalog = await res.json();
      break;
    } catch (e) {
      console.warn(`tracks.json fetch failed from ${url}:`, e);
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

  $resume.hidden = true;
  $audio.addEventListener('loadedmetadata', onMetadataReady, { once: true });
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
    controls: ['play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings'],
    settings: ['speed'],
    speed: { selected: 1, options: [0.75, 1, 1.25, 1.5, 1.75, 2] },
  });
}

loadCatalog();
