// Audio engine: owns the AudioContext, the master chain and the reverbs, and runs
// every sound as its own AudioWorklet node. The synthesis itself lives in synth.js.

const FADE_OUT = 45; // seconds the sleep timer takes to fade the mix out

// `level` balances the sounds against each other (measured with dev/analyze.html).
export const SOUNDS = [
  { id: 'rain', name: 'Rain', level: 0.7 },
  { id: 'thunder', name: 'Thunder', level: 1.429, reverb: 'outdoor' },
  { id: 'storm', name: 'Storm', level: 0.49, reverb: 'outdoor' },
  { id: 'wind', name: 'Wind', level: 2.3 },
  { id: 'ocean', name: 'Ocean', level: 1.841 },
  { id: 'river', name: 'River', level: 0.983, variants: ['Babbling', 'Flowing'] },
  { id: 'waterfall', name: 'Waterfall', level: 0.661 },
  { id: 'drops', name: 'Cave drips', level: 2.398, reverb: 'cave' },
  { id: 'fire', name: 'Campfire', level: 2.985 },
  { id: 'birds', name: 'Birds', level: 1.334 },
  { id: 'crickets', name: 'Crickets', level: 0.832 },
  { id: 'chimes', name: 'Wind chimes', level: 3.33, variants: ['Pentatonic', 'Minor', 'Deep', 'High'] },
  { id: 'bowl', name: 'Singing bowl', level: 2.455 },
  { id: 'drone', name: 'Drone', level: 0.724 },
  { id: 'binaural', name: 'Binaural', level: 0.355, variants: ['Theta 6 Hz', 'Alpha 10 Hz', 'Delta 3 Hz'] },
  { id: 'white', name: 'White noise', level: 0.24 },
  { id: 'pink', name: 'Pink noise', level: 0.295 },
  { id: 'brown', name: 'Brown noise', level: 0.684 },
];

const BY_ID = Object.fromEntries(SOUNDS.map((s) => [s.id, s]));

/* ------------------------------------------------------------------ */
/* Reverbs                                                             */
/* ------------------------------------------------------------------ */

const REVERBS = {
  room: { seconds: 2.6, rt60: 2.2, early: 6, bright: 0.85, dark: 0.15, gain: 0.7 },
  cave: { seconds: 6, rt60: 5, early: 24, bright: 0.95, dark: 0.45, gain: 0.8, predelay: 0.012 },
  outdoor: { seconds: 7, rt60: 5.5, early: 0, bright: 0.55, dark: 0.08, echoes: 7, gain: 0.8 },
};

// A decaying noise tail that darkens over time, plus early reflections off nearby
// surfaces and, outdoors, a few smeared echoes from far away.
function impulse(ctx, o) {
  const sr = ctx.sampleRate, n = Math.floor(o.seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const pre = Math.floor((o.predelay ?? 0.005) * sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const x = i / n;
      lp += (o.bright - (o.bright - o.dark) * x) * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-6.9 * i) / sr / o.rt60) * Math.min(1, (i - pre) / (0.01 * sr));
    }
    for (let k = 0; k < (o.early ?? 0); k++) {
      const i = pre + Math.floor((0.004 + Math.random() * 0.08) * sr);
      d[i] += (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.5) * Math.exp(-i / sr / 0.05);
    }
    for (let k = 0; k < (o.echoes ?? 0); k++) {
      const at = Math.floor((0.25 + Math.random() * 2.5) * sr), amp = 0.15 + 0.25 * Math.random();
      let e = 0;
      for (let j = 0; j < 0.12 * sr && at + j < n; j++) {
        e += 0.05 * (Math.random() * 2 - 1 - e);
        d[at + j] += e * amp * 4 * Math.exp(-j / (0.03 * sr));
      }
    }
  }
  return buf;
}

export class Shared {
  constructor(ctx, input) {
    this.ctx = ctx;
    this.input = input;
    this.reverbs = {};
  }

  // Input node of a reverb, created on first use.
  reverb(type = 'room') {
    if (!this.reverbs[type]) {
      const o = REVERBS[type], ctx = this.ctx;
      const conv = ctx.createConvolver(), inp = ctx.createGain(), ret = ctx.createGain();
      conv.buffer = impulse(ctx, o);
      ret.gain.value = o.gain;
      inp.connect(conv).connect(ret).connect(this.input);
      this.reverbs[type] = inp;
    }
    return this.reverbs[type];
  }
}

export function loadSynth(ctx, query = '') {
  return ctx.audioWorklet.addModule(new URL(`synth.js${query}`, import.meta.url));
}

// A sound as a worklet node: output 0 is dry, output 1 goes to the reverb.
export function createVoice(ctx, id, variant) {
  return new AudioWorkletNode(ctx, 'synth', {
    numberOfInputs: 0,
    numberOfOutputs: 2,
    outputChannelCount: [2, 2],
    processorOptions: { kind: id, variant },
  });
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

const volumeToGain = (v) => v * v;

export class Engine {
  constructor() {
    this.ctx = null;
    this.voices = new Map();
    this.token = 0;
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
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    this.input = ctx.createGain();
    this.input.connect(comp).connect(this.master).connect(ctx.destination);
    this.sh = new Shared(ctx, this.input);
    this.ready = loadSynth(ctx);
    this.ready.catch((e) => console.error('Could not load the synthesiser', e));
  }

  has(id) {
    return this.voices.has(id);
  }

  enable(id, volume, variant) {
    if (!this.ctx || this.voices.has(id)) return;
    const def = BY_ID[id], ctx = this.ctx, t = ctx.currentTime + 0.05;
    const dry = ctx.createGain(), wet = ctx.createGain();
    dry.connect(this.input);
    wet.connect(this.sh.reverb(def.reverb));
    for (const g of [dry, wet]) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(def.level * volumeToGain(volume), t + 1.5);
    }
    const v = { def, dry, wet, volume, node: null, stopped: false };
    this.voices.set(id, v);
    this.ready.then(() => {
      if (v.stopped) return;
      v.node = createVoice(ctx, id, variant);
      v.node.connect(dry, 0);
      v.node.connect(wet, 1);
    });
  }

  disable(id, fade = 1.2) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    v.stopped = true;
    const t = this.ctx.currentTime;
    for (const g of [v.dry, v.wet]) this.ramp(g.gain, 0, t, fade);
    setTimeout(() => {
      v.node?.port.postMessage('stop');
      v.node?.disconnect();
      v.dry.disconnect();
      v.wet.disconnect();
    }, (fade + 0.3) * 1000);
  }

  setVolume(id, volume) {
    const v = this.voices.get(id);
    if (!v) return;
    v.volume = volume;
    for (const g of [v.dry, v.wet]) this.ramp(g.gain, v.def.level * volumeToGain(volume), this.ctx.currentTime, 0.08);
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
    resumed.catch(() => {});
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
