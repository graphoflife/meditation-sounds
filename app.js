import { SOUNDS, Engine } from './audio.js';
import { icon } from './icons.js';

const STORE = 'meditation-sounds';
const TIMER_STEPS = [0, 10, 20, 30, 45, 60, 90]; // minutes
const DEFAULT_VOLUME = 0.7;

const engine = new Engine();
const byId = Object.fromEntries(SOUNDS.map((s) => [s.id, s]));
const state = load();
let playing = false;
let timerEnd = 0; // Date.now() at which the sleep timer runs out, while playing
let timerLeft = 0; // ms left on the timer while paused

const $ = (id) => document.getElementById(id);
const grid = $('grid'), playBtn = $('play'), timerBtn = $('timer'), clearBtn = $('clear'), statusEl = $('status');

function load() {
  const base = { on: [], vol: {}, variant: {}, timer: 0 };
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {}
  const s = { ...base, ...saved };
  s.on = s.on.filter((id) => byId[id]);
  if (!TIMER_STEPS.includes(s.timer)) s.timer = 0;
  return s;
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {}
}

const volumeOf = (id) => state.vol[id] ?? DEFAULT_VOLUME;
const variantOf = (id) => {
  const v = byId[id].variants;
  return v && v[(state.variant[id] ?? 0) % v.length];
};

/* ---------- keep-alive ---------- */

// Near-silent WAV (dither at about -84 dBFS, so no platform treats it as pure silence).
function silentWav(seconds = 10, rate = 8000) {
  const n = seconds * rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * 2), true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// A looping media element playing alongside Web Audio. It makes the browser treat
// the page as a media player, so audio keeps going with the screen off and the
// lock-screen / notification controls appear.
const keepAlive = {
  el: null,
  play() {
    if (!this.el) {
      this.el = new Audio(silentWav());
      this.el.loop = true;
      this.el.setAttribute('playsinline', '');
      // paused from outside (e.g. headphones unplugged): follow along
      this.el.addEventListener('pause', () => playing && pause());
    }
    this.el.play().catch(() => {});
  },
  pause() {
    this.el?.pause();
  },
};

/* ---------- playback ---------- */

function play() {
  if (!state.on.length) return;
  engine.init(); // needs the user gesture, so this runs first
  keepAlive.play();
  if (state.timer && !timerLeft) timerLeft = state.timer * 60000;
  timerEnd = state.timer ? Date.now() + timerLeft : 0;
  engine.resume(timerEnd ? timerLeft / 1000 : null);
  for (const id of state.on) engine.enable(id, volumeOf(id), variantOf(id));
  playing = true;
  render();
}

function pause() {
  if (!playing) return;
  playing = false;
  if (timerEnd) timerLeft = Math.max(0, timerEnd - Date.now());
  timerEnd = 0;
  engine.suspend();
  keepAlive.pause();
  render();
}

function toggle(id) {
  if (state.on.includes(id)) {
    state.on = state.on.filter((x) => x !== id);
    engine.disable(id);
    if (!state.on.length) pause();
  } else {
    state.on.push(id);
    if (playing) engine.enable(id, volumeOf(id), variantOf(id));
    else play();
  }
  save();
  render();
}

function cycleVariant(id) {
  state.variant[id] = ((state.variant[id] ?? 0) + 1) % byId[id].variants.length;
  engine.setVariant(id, variantOf(id));
  save();
  render();
}

function cycleTimer() {
  state.timer = TIMER_STEPS[(TIMER_STEPS.indexOf(state.timer) + 1) % TIMER_STEPS.length];
  timerLeft = state.timer * 60000;
  if (playing) {
    timerEnd = state.timer ? Date.now() + timerLeft : 0;
    engine.resume(timerEnd ? timerLeft / 1000 : null);
  }
  save();
  render();
}

function clearAll() {
  for (const id of state.on) engine.disable(id);
  state.on = [];
  pause();
  save();
  render();
}

/* ---------- view ---------- */

for (const s of SOUNDS) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = s.id;
  tile.innerHTML = `
    <button class="toggle" type="button" aria-pressed="false">
      <span class="icon">${icon(s.id)}</span>
      <span class="name">${s.name}</span>
    </button>
    ${s.variants ? `<button class="variant" type="button" aria-label="${s.name} variant"></button>` : ''}
    <input class="vol" type="range" min="0" max="1" step="0.01" aria-label="${s.name} volume">`;
  grid.append(tile);
}

timerBtn.innerHTML = `${icon('timer')}<span></span>`;
clearBtn.innerHTML = `${icon('clear')}<span>Clear</span>`;
const timerLabel = timerBtn.querySelector('span');

const paintSlider = (el) => el.style.setProperty('--p', `${el.value * 100}%`);

const clock = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function renderTimer() {
  const full = state.timer * 60000;
  const left = timerEnd ? Math.max(0, timerEnd - Date.now()) : timerLeft;
  timerLabel.textContent = !state.timer ? 'Timer' : playing || (left && left < full) ? clock(left) : `${state.timer} min`;
  timerBtn.classList.toggle('active', !!state.timer);
}

function render() {
  for (const tile of grid.children) {
    const id = tile.dataset.id, on = state.on.includes(id);
    tile.classList.toggle('on', on);
    tile.querySelector('.toggle').setAttribute('aria-pressed', on);
    const vol = tile.querySelector('.vol');
    vol.value = volumeOf(id);
    vol.tabIndex = on ? 0 : -1;
    paintSlider(vol);
    const variant = tile.querySelector('.variant');
    if (variant) variant.textContent = variantOf(id);
  }
  const names = state.on.map((id) => byId[id].name);
  document.body.classList.toggle('playing', playing);
  playBtn.innerHTML = icon(playing ? 'pause' : 'play');
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  playBtn.disabled = clearBtn.disabled = !names.length;
  statusEl.textContent = names.length ? `${playing ? 'Playing' : 'Paused'} · ${names.join(', ')}` : 'Tap a sound to begin';
  renderTimer();
  updateMediaSession(names);
}

function updateMediaSession(names) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: names.length ? names.join(' · ') : 'Meditation Sounds',
      artist: 'Meditation Sounds',
      artwork: [192, 512].map((s) => ({ src: `icons/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png' })),
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  } catch {}
}

/* ---------- events ---------- */

grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('.vol')) return;
  if (e.target.closest('.variant')) cycleVariant(tile.dataset.id);
  else toggle(tile.dataset.id);
});

grid.addEventListener('input', (e) => {
  if (!e.target.matches('.vol')) return;
  const id = e.target.closest('.tile').dataset.id;
  state.vol[id] = +e.target.value;
  engine.setVolume(id, state.vol[id]);
  paintSlider(e.target);
  save();
});

playBtn.addEventListener('click', () => (playing ? pause() : play()));
timerBtn.addEventListener('click', cycleTimer);
clearBtn.addEventListener('click', clearAll);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    playing ? pause() : play();
  }
});

if ('mediaSession' in navigator) {
  for (const [action, fn] of [['play', play], ['pause', pause], ['stop', pause]]) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  }
}

// Back from the lock screen: audio may have been interrupted (calls, Siri).
document.addEventListener('visibilitychange', () => {
  const ctx = engine.ctx;
  if (document.hidden || !playing || !ctx || ctx.state === 'running') return;
  ctx.resume().catch(() => {});
  setTimeout(() => ctx.state !== 'running' && pause(), 800);
});

setInterval(() => {
  if (playing && timerEnd && Date.now() >= timerEnd) pause();
  if (playing) renderTimer();
}, 1000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
