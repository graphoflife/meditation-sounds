// Audio engine. Nature sounds are real field recordings (sounds/*.mp3, see CREDITS.md):
// beds loop seamlessly, and sparse events like thunder or a bowl strike are played as
// one-shots at random times so they never fall into a pattern. Pure signals (noise,
// binaural beats) are generated live in synth.js.

const FADE_OUT = 45; // seconds the sleep timer takes to fade the mix out
const LOOP_FADE = 4; // seconds of crossfade over the loop seam
const LOOKAHEAD = 90; // seconds of one-shots booked ahead, so hidden-page timers can't cause gaps

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const THUNDER = ['thunder-1', 'thunder-2', 'thunder-3', 'thunder-4', 'thunder-5', 'thunder-6'];

// config: `loop` (a recording), `shots` (recordings played at random times),
// `synth` (a generator in synth.js), `level` (balance, measured with ffmpeg's ebur128).
// Where variants exist they are different recordings, chosen on the tile.
export const SOUNDS = [
  {
    id: 'rain',
    name: 'Rain',
    variants: ['Forest', 'Heavy', 'Tent'],
    config: {
      Forest: { loop: 'rain-forest', level: 1.4 },
      Heavy: { loop: 'rain-heavy', level: 0.79 },
      Tent: { loop: 'rain-tent', level: 1.4 },
    },
  },
  { id: 'thunder', name: 'Thunder', config: { shots: { files: THUNDER, gap: [14, 50], first: [0.5, 2], rate: [0.92, 1.05], pan: 0.5 }, level: 1 } },
  {
    id: 'storm',
    name: 'Storm',
    variants: ['Thunder', 'Downpour'],
    config: {
      Thunder: { loop: 'storm-thunder', level: 1.12 },
      Downpour: { loop: 'storm-downpour', level: 1.0, shots: { files: THUNDER, gap: [25, 80], first: [8, 25], rate: [0.92, 1.05], pan: 0.5, gain: 0.7 } },
    },
  },
  {
    id: 'wind',
    name: 'Wind',
    variants: ['Trees', 'Howling'],
    config: { Trees: { loop: 'wind-trees', level: 0.79 }, Howling: { loop: 'wind-howling', level: 1.14 } },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    variants: ['Waves', 'Gentle'],
    config: { Waves: { loop: 'ocean-waves', level: 1.06 }, Gentle: { loop: 'ocean-gentle', level: 0.79 } },
  },
  {
    id: 'river',
    name: 'River',
    variants: ['Babbling', 'Flowing'],
    config: { Babbling: { loop: 'river-babbling', level: 0.79 }, Flowing: { loop: 'river-flowing', level: 0.79 } },
  },
  { id: 'waterfall', name: 'Waterfall', config: { loop: 'waterfall', level: 0.71 } },
  {
    id: 'drops',
    name: 'Cave drips',
    variants: ['Echo', 'Natural'],
    config: { Echo: { loop: 'cave-echo', level: 1.4 }, Natural: { loop: 'cave-natural', level: 1.17 } },
  },
  {
    id: 'fire',
    name: 'Campfire',
    variants: ['Crackling', 'Forest'],
    config: { Crackling: { loop: 'fire-crackling', level: 1.4 }, Forest: { loop: 'fire-forest', level: 1.02 } },
  },
  {
    id: 'birds',
    name: 'Birds',
    variants: ['Dawn', 'Forest'],
    config: { Dawn: { loop: 'birds-dawn', level: 0.63 }, Forest: { loop: 'birds-forest', level: 0.86 } },
  },
  {
    id: 'crickets',
    name: 'Crickets',
    variants: ['Night', 'Close'],
    config: { Night: { loop: 'crickets-night', level: 0.5 }, Close: { loop: 'crickets-close', level: 0.4 } },
  },
  {
    id: 'chimes',
    name: 'Wind chimes',
    variants: ['Natural', 'Deep', 'High'],
    config: {
      Natural: { loop: 'chimes', level: 0.73 },
      Deep: { loop: 'chimes', rate: 0.75, level: 0.73 },
      High: { loop: 'chimes', rate: 1.3, level: 0.73 },
    },
  },
  { id: 'bowl', name: 'Singing bowl', config: { shots: { files: ['bowl-1', 'bowl-2'], gap: [24, 48], first: [0.2, 0.6], rate: [0.995, 1.005], pan: 0.2 }, level: 0.8 } },
  { id: 'drone', name: 'Tanpura', config: { loop: 'tanpura', level: 0.63 } },
  {
    id: 'binaural',
    name: 'Binaural',
    variants: ['Theta 6 Hz', 'Alpha 10 Hz', 'Delta 3 Hz'],
    config: { synth: true, level: 0.355 },
  },
  { id: 'white', name: 'White noise', config: { synth: true, level: 0.24 } },
  { id: 'pink', name: 'Pink noise', config: { synth: true, level: 0.295 } },
  {
    id: 'brown',
    name: 'Brown noise',
    variants: ['Classic', 'Deep', 'Smooth', 'Light', 'Waves'],
    config: { synth: true, level: 0.684 },
  },
];

const BY_ID = Object.fromEntries(SOUNDS.map((s) => [s.id, s]));
const configOf = (def, variant) => (def.variants && def.config[variant]?.level != null ? def.config[variant] : def.config);
const volumeToGain = (v) => v * v;

/* ------------------------------------------------------------------ */
/* Recordings                                                          */
/* ------------------------------------------------------------------ */

// Chromium can get stuck replaying the last render block of a looping buffer when
// frames / sampleRate isn't exact in floating point; multiples of the rate's odd part are.
function exactFrames(frames, rate) {
  let odd = rate;
  while (odd % 2 === 0) odd /= 2;
  return Math.floor(frames / odd) * odd;
}

// Turns a recording into a seamless loop by crossfading its end into its start.
// This happens after decoding, so MP3 encoder padding can't leave a gap at the seam.
function seamlessLoop(ctx, buf) {
  const sr = buf.sampleRate, fade = Math.floor(LOOP_FADE * sr);
  const n = exactFrames(buf.length - fade, sr);
  const out = ctx.createBuffer(buf.numberOfChannels, n, sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch), dst = out.getChannelData(ch);
    dst.set(src.subarray(0, n));
    for (let i = 0; i < fade; i++) {
      const x = i / fade;
      dst[i] = src[i] * Math.sqrt(x) + src[n + i] * Math.sqrt(1 - x);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class Engine {
  constructor() {
    this.ctx = null;
    this.voices = new Map();
    this.buffers = new Map(); // "name" or "name#loop" -> Promise<AudioBuffer>
    this.token = 0;
    this.onLoading = () => {}; // (id, isLoading)
    this.onError = () => {}; // (id)
  }

  // Must be called from a user gesture (iOS only unlocks audio there).
  init() {
    if (this.ctx) return;
    try {
      // iOS 16.4+: keep playing with the silent switch on and the screen locked
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'playback' });
    } catch {
      ctx = new AC();
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    // a safety net for loud mixes and rare spikes
    comp.threshold.value = -8;
    comp.knee.value = 6;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.input = ctx.createGain();
    this.input.connect(comp).connect(this.master).connect(ctx.destination);
    this.synthReady = ctx.audioWorklet.addModule(new URL('synth.js', import.meta.url));
    this.synthReady.catch((e) => console.error('Could not load the synthesiser', e));
    setInterval(() => this.bookShots(), 1000);
  }

  has(id) {
    return this.voices.has(id);
  }

  // Decoded recordings are shared, e.g. thunder between Thunder and Storm.
  load(name, asLoop) {
    const key = asLoop ? `${name}#loop` : name;
    if (!this.buffers.has(key)) {
      const url = new URL(`sounds/${name}.mp3`, import.meta.url);
      const p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${url}`);
          return r.arrayBuffer();
        })
        .then((data) => this.ctx.decodeAudioData(data))
        .then((buf) => (asLoop ? seamlessLoop(this.ctx, buf) : buf));
      p.catch(() => this.buffers.delete(key));
      this.buffers.set(key, p);
    }
    return this.buffers.get(key);
  }

  enable(id, volume, variant) {
    if (!this.ctx || this.voices.has(id)) return;
    const def = BY_ID[id], cfg = configOf(def, variant), ctx = this.ctx, t = ctx.currentTime + 0.05;
    const gain = ctx.createGain();
    gain.connect(this.input);
    gain.gain.setValueAtTime(0, t);
    const v = { id, cfg, gain, volume, variant, stopped: false, sources: [], next: 0, shots: null };
    this.voices.set(id, v);
    this.onLoading(id, true);
    this.startVoice(v)
      .then(() => {
        if (v.stopped) return;
        // fade in once there is something to hear
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0, now);
        // beds swell in; one-shots must keep their attack
        gain.gain.linearRampToValueAtTime(cfg.level * volumeToGain(v.volume), now + (cfg.loop || cfg.synth ? 1.5 : 0.02));
      })
      .catch((e) => {
        console.error(`Could not start ${id}`, e);
        if (!v.stopped) this.onError(id);
      })
      .finally(() => {
        if (!v.stopped) this.onLoading(id, false);
      });
  }

  async startVoice(v) {
    const { cfg, gain, id, variant } = v, ctx = this.ctx;
    const jobs = [];
    if (cfg.synth) {
      jobs.push(
        this.synthReady.then(() => {
          if (v.stopped) return;
          const node = new AudioWorkletNode(ctx, 'synth', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { kind: id, variant },
          });
          node.connect(gain);
          v.node = node;
        }),
      );
    }
    if (cfg.loop) {
      jobs.push(
        this.load(cfg.loop, true).then((buf) => {
          if (v.stopped) return;
          const s = ctx.createBufferSource();
          s.buffer = buf;
          s.loop = true;
          s.playbackRate.value = cfg.rate ?? 1;
          s.connect(gain);
          // a random entry point, so every session starts somewhere else
          s.start(ctx.currentTime + 0.02, rand(0, buf.duration));
          v.sources.push(s);
        }),
      );
    }
    if (cfg.shots) {
      jobs.push(
        Promise.all(cfg.shots.files.map((f) => this.load(f, false))).then((bufs) => {
          if (v.stopped) return;
          v.shots = bufs;
          v.next = ctx.currentTime + rand(...cfg.shots.first);
          this.bookShots();
        }),
      );
    }
    await Promise.all(jobs);
  }

  // Books one-shots ahead on the audio clock, avoiding the one that was just played.
  bookShots() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    for (const v of this.voices.values()) {
      if (!v.shots) continue;
      const o = v.cfg.shots;
      while (v.next < ctx.currentTime + LOOKAHEAD) {
        let buf = pick(v.shots);
        if (buf === v.last && v.shots.length > 1) buf = pick(v.shots.filter((b) => b !== v.last));
        v.last = buf;
        const s = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
        s.buffer = buf;
        s.playbackRate.value = rand(...o.rate);
        g.gain.value = (o.gain ?? 1) * rand(0.7, 1);
        p.pan.value = rand(-o.pan, o.pan);
        s.connect(g).connect(p).connect(v.gain);
        s.onended = () => v.sources.splice(v.sources.indexOf(s), 1);
        s.start(Math.max(v.next, ctx.currentTime + 0.02));
        v.sources.push(s);
        v.next += rand(...o.gap);
      }
    }
  }

  disable(id, fade = 1.2) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    v.stopped = true;
    this.onLoading(id, false);
    const t = this.ctx.currentTime;
    this.ramp(v.gain.gain, 0, t, fade);
    setTimeout(() => {
      for (const s of [...v.sources]) {
        s.onended = null;
        try {
          s.stop();
        } catch {}
      }
      v.node?.port.postMessage('stop');
      v.node?.disconnect();
      v.gain.disconnect();
      this.dropUnused();
    }, (fade + 0.3) * 1000);
  }

  // Decoded audio is large, so anything no active sound needs is released.
  dropUnused() {
    const used = new Set();
    for (const v of this.voices.values()) {
      if (v.cfg.loop) used.add(`${v.cfg.loop}#loop`);
      for (const f of v.cfg.shots?.files ?? []) used.add(f);
    }
    for (const key of this.buffers.keys()) if (!used.has(key)) this.buffers.delete(key);
  }

  setVolume(id, volume) {
    const v = this.voices.get(id);
    if (!v) return;
    v.volume = volume;
    this.ramp(v.gain.gain, v.cfg.level * volumeToGain(volume), this.ctx.currentTime, 0.08);
  }

  // Crossfades to a fresh instance with the new variant.
  setVariant(id, variant) {
    const v = this.voices.get(id);
    if (!v) return;
    this.disable(id, 2);
    this.enable(id, v.volume, variant);
  }

  ramp(param, value, t, dur) {
    const cur = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(cur, t);
    param.linearRampToValueAtTime(value, t + dur);
  }

  // Fades the mix in. With `endIn` (seconds), it also schedules the sleep-timer
  // fade-out on the audio clock, so it happens even if the page's timers are paused.
  resume(endIn = null) {
    this.token++;
    const ctx = this.ctx;
    const resumed = ctx.state !== 'running' ? ctx.resume() : Promise.resolve();
    const t = ctx.currentTime, g = this.master.gain, cur = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(cur, t);
    if (endIn == null) {
      g.linearRampToValueAtTime(1, t + 0.6);
    } else {
      const end = t + Math.max(endIn, 0.7), fadeStart = end - FADE_OUT;
      if (fadeStart > t + 0.6) {
        g.linearRampToValueAtTime(1, t + 0.6);
        g.setValueAtTime(1, fadeStart);
      } else {
        g.linearRampToValueAtTime((end - t - 0.6) / FADE_OUT, t + 0.6);
      }
      g.linearRampToValueAtTime(0, end);
    }
    resumed.then(() => this.bookShots()).catch(() => {});
    return resumed;
  }

  suspend() {
    const token = ++this.token, ctx = this.ctx;
    if (!ctx) return;
    this.ramp(this.master.gain, 0, ctx.currentTime, 0.3);
    setTimeout(() => {
      if (token === this.token && ctx.state === 'running') ctx.suspend();
    }, 400);
  }
}
