// Procedural ambient sound engine built on the Web Audio API.
// Nothing is sampled: every sound is synthesised at runtime from noise loops,
// filters, oscillators, pre-rendered micro-event loops (drops, bubbles,
// crackles, chirps) and events scheduled ahead of time (thunder, chimes, birds).

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const FADE_OUT = 45; // seconds the sleep timer takes to fade the mix out

/* ------------------------------------------------------------------ */
/* Buffers                                                             */
/* ------------------------------------------------------------------ */

function genWhite(out) {
  for (let i = 0; i < out.length; i++) out[i] = Math.random() * 2 - 1;
}

// Paul Kellet's refined pink noise filter.
function genPink(out) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
}

// Leaky integrator: -6 dB/octave above ~150 Hz.
function genBrown(out) {
  let l = 0;
  for (let i = 0; i < out.length; i++) {
    l = (l + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    out[i] = l;
  }
}

const GENERATORS = { white: genWhite, pink: genPink, brown: genBrown };

// Loop length in frames whose duration (frames / rate) is exact in floating point.
// Chromium can get stuck replaying the last render block of a looping buffer
// when it isn't, which is heard as a 375 Hz buzz.
function loopFrames(seconds, rate) {
  let odd = rate;
  while (odd % 2 === 0) odd /= 2;
  return Math.max(1, Math.round((seconds * rate) / odd)) * odd;
}

function scaleToRms(buf, target) {
  let sum = 0, count = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    count += d.length;
  }
  const k = target / (Math.sqrt(sum / count) || 1);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

// Stereo noise loop whose end is crossfaded into its start, so it loops seamlessly.
function noiseLoop(ctx, color, seconds = 6) {
  const sr = ctx.sampleRate;
  const n = loopFrames(seconds, sr), fade = Math.floor(0.3 * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const tmp = new Float32Array(n + fade);
  for (let ch = 0; ch < 2; ch++) {
    GENERATORS[color](tmp);
    const d = buf.getChannelData(ch);
    d.set(tmp.subarray(0, n));
    for (let i = 0; i < fade; i++) {
      const x = i / fade;
      d[i] = tmp[i] * Math.sqrt(x) + tmp[n + i] * Math.sqrt(1 - x);
    }
  }
  scaleToRms(buf, 0.2);
  return buf;
}

// Mono loop filled with `count` short events. Events running past the end wrap
// around to the start, so the loop has no seam.
function eventLoop(ctx, seconds, count, draw, rate = ctx.sampleRate) {
  const buf = ctx.createBuffer(1, loopFrames(seconds, rate), rate);
  const d = buf.getChannelData(0), n = d.length;
  const put = (i, v) => { d[i % n] += v; };
  for (let k = 0; k < count; k++) draw(put, Math.floor(Math.random() * n), rate);
  return buf;
}

function drawRaindrop(put, start, sr) {
  const amp = 0.03 + Math.random() ** 4 * 0.6;
  const r = Math.random();
  if (r < 0.06) {
    // plink: a tiny resonance with rising pitch
    const f0 = rand(1800, 4500), tau = rand(0.006, 0.018), len = Math.floor(tau * 6 * sr);
    let ph = 0;
    for (let j = 0; j < len; j++) {
      const t = j / sr;
      ph += (TAU * f0 * (1 + 20 * t)) / sr;
      put(start + j, Math.sin(ph) * Math.exp(-t / tau) * amp * 0.5);
    }
  } else if (r < 0.55) {
    // bright tick: differentiated noise burst
    const tau = rand(0.0004, 0.002), len = Math.floor(tau * 6 * sr);
    let prev = 0;
    for (let j = 0; j < len; j++) {
      const w = Math.random() * 2 - 1;
      put(start + j, (w - prev) * 0.5 * Math.exp(-j / (tau * sr)) * amp);
      prev = w;
    }
  } else {
    // soft pat: low-passed noise burst
    const tau = rand(0.002, 0.006), len = Math.floor(tau * 6 * sr), k = rand(0.15, 0.35);
    let lp = 0;
    for (let j = 0; j < len; j++) {
      lp += k * (Math.random() * 2 - 1 - lp);
      put(start + j, lp * Math.exp(-j / (tau * sr)) * amp * 1.5);
    }
  }
}

// Air bubble in water (Minnaert resonance with rising pitch, after van den Doel).
function drawBubble(fmin, fmax, ampScale = 1) {
  return (put, start, sr) => {
    const f0 = fmin * (fmax / fmin) ** Math.random();
    const d = 0.13 * f0 + 0.0072 * f0 ** 1.5; // damping, 1/s
    const sigma = rand(0.06, 0.2) * d;
    const amp = rand(0.15, 0.6) * (fmin / f0) ** 0.4 * ampScale;
    const len = Math.min(Math.floor((6 / d) * sr), Math.floor(0.12 * sr));
    const attack = 0.0006 * sr;
    let ph = 0;
    for (let j = 0; j < len; j++) {
      const t = j / sr;
      ph += (TAU * f0 * (1 + sigma * t)) / sr;
      put(start + j, Math.sin(ph) * Math.exp(-d * t) * amp * Math.min(1, j / attack));
    }
  };
}

function drawCrackle(put, start, sr) {
  const big = chance(0.12);
  const amp = big ? rand(0.35, 0.8) : 0.04 + Math.random() ** 2.5 * 0.45;
  let pos = start;
  for (let c = big ? randInt(1, 3) : randInt(1, 5); c > 0; c--) {
    const tau = big ? rand(0.0015, 0.004) : rand(0.0002, 0.001);
    const k = big ? rand(0.12, 0.3) : rand(0.5, 0.9);
    const a = amp * (pos === start ? 1 : rand(0.25, 0.8)) * (big ? 1.4 : 1);
    const len = Math.floor(tau * 7 * sr);
    let lp = 0, prev = 0;
    for (let j = 0; j < len; j++) {
      lp += k * (Math.random() * 2 - 1 - lp);
      put(pos + j, (big ? lp : lp - prev) * a * Math.exp(-j / (tau * sr)));
      prev = lp;
    }
    pos += Math.floor(rand(0.002, 0.03) * sr);
  }
  if (big && chance(0.5)) {
    // sizzle after a pop
    for (let s = randInt(4, 12); s > 0; s--) {
      const p = pos + Math.floor(rand(0.01, 0.3) * sr), a = amp * rand(0.03, 0.12);
      const tau = rand(0.0002, 0.0006) * sr;
      let prev = 0;
      for (let j = 0; j < tau * 7; j++) {
        const w = Math.random() * 2 - 1;
        put(p + j, (w - prev) * a * Math.exp(-j / tau));
        prev = w;
      }
    }
  }
}

// One cricket: chirps of a few sine pulses, repeated `reps` times per loop.
function cricketLoop(ctx, { f, period, reps, pulses, pulseDur, pulseGap }) {
  const sr = Math.min(ctx.sampleRate, 24000);
  const buf = ctx.createBuffer(1, loopFrames(reps * period, sr), sr);
  const d = buf.getChannelData(0), n = d.length;
  const pl = Math.floor(pulseDur * sr);
  for (let r = 0; r < reps; r++) {
    if (chance(0.06)) continue;
    const t0 = (r + rand(-0.06, 0.06)) * period;
    let ph = Math.random() * TAU;
    for (let p = 0; p < pulses; p++) {
      const s0 = Math.floor((t0 + p * (pulseDur + pulseGap)) * sr);
      const a = (p === 0 ? 0.6 : 1) * rand(0.85, 1);
      for (let j = 0; j < pl; j++) {
        const x = j / pl;
        ph += (TAU * f * (1 - 0.04 * x)) / sr;
        d[(((s0 + j) % n) + n) % n] += (Math.sin(ph) + 0.12 * Math.sin(2 * ph)) * Math.sin(Math.PI * x) ** 2 * a * 0.5;
      }
    }
  }
  return buf;
}

// Synthetic room: decaying noise that darkens over time.
function impulse(ctx, seconds = 3.2) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const x = i / n;
      lp += (0.9 - 0.75 * x) * (Math.random() * 2 - 1 - lp);
      d[i] = lp * (1 - x) ** 3.5 * Math.min(1, i / (0.005 * sr));
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* Shared graph                                                        */
/* ------------------------------------------------------------------ */

export class Shared {
  constructor(ctx, input) {
    this.ctx = ctx;
    this.verbIn = ctx.createGain();
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx);
    const ret = ctx.createGain();
    ret.gain.value = 0.7;
    this.verbIn.connect(verb).connect(ret).connect(input);
    this.buffers = {};
  }

  noise(color) {
    return (this.buffers[color] ??= noiseLoop(this.ctx, color));
  }
}

/* ------------------------------------------------------------------ */
/* Sound base                                                          */
/* ------------------------------------------------------------------ */

class Sound {
  static level = 1;

  constructor(sh, opts = {}) {
    this.sh = sh;
    this.ctx = sh.ctx;
    this.opts = opts;
    const level = this.constructor.level * (opts.level ?? 1);
    this.out = this.gain(level); // dry output
    this.wet = this.gain(level); // reverb send
    this.nodes = []; // long-running sources, stopped in stop()
    this.parts = []; // sub-sounds (Storm)
  }

  start(t) {}

  schedule(until) {
    for (const p of this.parts) p.schedule(until);
  }

  stop(t) {
    for (const n of this.nodes) {
      try { n.stop(t); } catch {}
    }
    for (const p of this.parts) p.stop(t);
  }

  // Runs fn(t) for each event before `until`; fn returns the gap to the next one.
  each(ev, until, fn) {
    const earliest = this.ctx.currentTime + 0.03;
    while (ev.next < until) {
      const t = Math.max(ev.next, earliest);
      ev.next = t + fn(t);
    }
  }

  gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter(type, freq, Q = 0.707) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = Q;
    return f;
  }

  pan(p) {
    if (this.ctx.createStereoPanner) {
      const s = this.ctx.createStereoPanner();
      s.pan.value = p;
      return s;
    }
    const s = this.ctx.createPanner();
    s.panningModel = 'equalpower';
    s.setPosition(p, 0, 1 - Math.abs(p));
    return s;
  }

  shaper(fn, size = 1024) {
    const ws = this.ctx.createWaveShaper();
    const c = new Float32Array(size);
    for (let i = 0; i < size; i++) c[i] = fn((i / (size - 1)) * 2 - 1);
    ws.curve = c;
    return ws;
  }

  chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  send(node, amount) {
    node.connect(this.gain(amount)).connect(this.wet);
  }

  modulate(param, signal, depth) {
    signal.connect(this.gain(depth)).connect(param);
  }

  // Endless looping source starting at a random point of the buffer.
  loop(buffer, t, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t, rand(0, buffer.duration));
    this.nodes.push(s);
    return s;
  }

  // One-shot slice of a looping buffer, for events.
  source(buffer, t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.start(t, rand(0, buffer.duration));
    s.stop(t + dur + 0.05);
    return s;
  }

  osc(freq, t, type = 'sine') {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.start(t);
    this.nodes.push(o);
    return o;
  }

  // Slow, organic modulation: a sum of sines at unrelated frequencies, roughly within ±1.
  lfo(t, n, fmin, fmax) {
    const sum = this.gain(1.5 / n);
    for (let i = 0; i < n; i++) this.osc(rand(fmin, fmax), t).connect(sum);
    return sum;
  }

  // A decaying sine partial, for chimes and bowls.
  ring(t, f, amp, t60, dest, attack = 0.002) {
    const o = this.ctx.createOscillator(), g = this.gain(0);
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + attack);
    g.gain.setTargetAtTime(0, t + attack, t60 / 6.9);
    this.chain(o, g, dest);
    o.start(t);
    o.stop(t + t60);
  }

  part(Cls, opts, level, t) {
    const p = new Cls(this.sh, opts);
    p.out.connect(this.gain(level)).connect(this.out);
    p.wet.connect(this.gain(level)).connect(this.wet);
    p.start(t);
    this.parts.push(p);
  }
}

/* ------------------------------------------------------------------ */
/* Sounds                                                              */
/* ------------------------------------------------------------------ */

class Noise extends Sound {
  start(t) {
    // Two copies at different speeds never line up, so the loop can't be heard.
    const buf = this.sh.noise(this.opts.color);
    const mix = this.gain(Math.SQRT1_2);
    this.loop(buf, t).connect(mix);
    this.loop(buf, t, 0.937).connect(mix);
    if (this.opts.color === 'brown') this.chain(mix, this.filter('highpass', 30), this.out);
    else mix.connect(this.out);
  }
}

class Rain extends Sound {
  static level = 0.93;

  start(t) {
    const heavy = !!this.opts.heavy, sh = this.sh;
    const bus = this.gain(1);
    bus.connect(this.out);
    this.send(bus, heavy ? 0.12 : 0.18);
    this.modulate(bus.gain, this.lfo(t, 3, 0.02, 0.07), heavy ? 0.2 : 0.15);
    this.chain(
      this.loop(sh.noise('pink'), t),
      this.filter('highpass', heavy ? 300 : 450),
      this.filter('lowpass', heavy ? 10000 : 7500),
      this.gain(heavy ? 1 : 0.55),
      bus,
    );
    this.chain(this.loop(sh.noise('brown'), t), this.filter('lowpass', heavy ? 700 : 400), this.gain(heavy ? 0.6 : 0.3), bus);
    const density = heavy ? 520 : 300;
    for (const [sec, p] of [[5.3, -0.55], [7.9, 0.55], [6.7, 0]]) {
      const buf = eventLoop(this.ctx, sec, Math.round((sec * density) / 3), drawRaindrop);
      this.chain(this.loop(buf, t), this.pan(p), bus);
    }
  }
}

class Thunder extends Sound {
  static level = 1.55;

  start(t) {
    this.ev = { next: t + rand(1, 3) };
  }

  schedule(until) {
    const { min = 14, max = 45 } = this.opts;
    this.each(this.ev, until, (t) => {
      this.strike(t);
      return rand(min, max);
    });
  }

  strike(t) {
    const dist = this.opts.close ? rand(0, 0.75) : rand(0.2, 1);
    const D = rand(6, 11) * (0.8 + 0.5 * dist);
    const att = 0.03 + dist * rand(0.4, 1.4);
    const peak = 1 - 0.6 * dist;
    const fHi = 3200 * (1 - dist) ** 1.5 + 450, fLo = rand(140, 220);
    // a few rolling swells give the rumble its shape
    const bumps = Array.from({ length: randInt(3, 7) }, () => [rand(0, 0.55), rand(0.03, 0.1), rand(0.3, 1)]);
    const N = 256, env = new Float32Array(N), cut = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1), s = x * D;
      const shape = s < att ? s / att : Math.exp(-(s - att) / (D * 0.25));
      let roll = 0.3;
      for (const [p, w, h] of bumps) roll += h * Math.exp(-(((x - p) / w) ** 2));
      env[i] = peak * shape * Math.min(roll, 1.6) * (1 - x);
      cut[i] = fLo + (fHi - fLo) * Math.exp(-s / (0.4 + dist * 1.5));
    }
    const pan = this.pan(rand(-0.6, 0.6));
    pan.connect(this.out);
    this.send(pan, 0.2 + 0.3 * dist);
    const lp = this.filter('lowpass', fHi, 0.6);
    lp.frequency.setValueCurveAtTime(cut, t, D);
    const g = this.gain(0);
    g.gain.setValueCurveAtTime(env, t, D);
    this.chain(this.source(this.sh.noise('brown'), t, D), lp, g, pan);
    if (dist < 0.4) this.crack(t, pan, 1 - dist);
  }

  crack(t, dest, k) {
    const D = rand(0.8, 1.6), N = 160;
    const env = new Float32Array(N), cut = new Float32Array(N);
    for (let i = 1; i < N; i++) {
      const x = i / (N - 1), s = x * D;
      env[i] = k * 0.8 * Math.exp(-s / 0.25) * (0.35 + 0.65 * Math.random() ** 2) * (1 - x);
      cut[i] = 900 + 6000 * Math.exp(-s / 0.3);
    }
    cut[0] = cut[1];
    const lp = this.filter('lowpass', cut[0]);
    lp.frequency.setValueCurveAtTime(cut, t, D);
    const g = this.gain(0);
    g.gain.setValueCurveAtTime(env, t, D);
    this.chain(this.source(this.sh.noise('white'), t, D), this.filter('highpass', 500), lp, g, dest);
  }
}

class Wind extends Sound {
  static level = 1.0;

  start(t) {
    const s = this.opts.strength ?? 1, sh = this.sh;
    // 0..1 gust envelope, reaching each layer with a small delay as it sweeps past
    const gust = this.chain(this.lfo(t, 3, 0.025, 0.1), this.shaper((x) => ((x + 1) / 2) ** 1.8));
    for (const [p, delay] of [[-0.7, 0], [0, 0.9], [0.7, 1.8]]) {
      const g = this.ctx.createDelay(4);
      g.delayTime.value = delay;
      gust.connect(g);
      const base = rand(300, 520) * s ** 0.5;
      const bp = this.filter('bandpass', base * 0.55, rand(0.7, 1.3));
      this.modulate(bp.frequency, g, base * 1.3);
      this.modulate(bp.frequency, this.lfo(t, 2, 0.2, 0.6), base * 0.1);
      const amp = this.gain(0.08);
      this.modulate(amp.gain, g, 0.92);
      this.chain(this.loop(sh.noise('pink'), t, rand(0.95, 1.05)), bp, amp, this.pan(p), this.out);
    }
    const roar = this.gain(0.15 * s);
    this.modulate(roar.gain, gust, 0.35 * s);
    this.chain(this.loop(sh.noise('brown'), t), this.filter('lowpass', 200 * s), roar, this.out);
    // a faint whistle that rises with the gusts
    const wf = rand(600, 900) * s;
    const wbp = this.filter('bandpass', wf, 12 + 6 * s);
    this.modulate(wbp.frequency, gust, wf * 0.7);
    const wg = this.gain(0);
    this.modulate(wg.gain, this.chain(gust, this.shaper((x) => x * x)), 0.35 * s);
    this.chain(this.loop(sh.noise('white'), t), wbp, wg, this.out);
  }
}

class Storm extends Sound {
  static level = 0.53;

  start(t) {
    this.part(Rain, { heavy: true }, 1, t);
    this.part(Wind, { strength: 1.6 }, 0.8, t);
    this.part(Thunder, { min: 8, max: 26, close: true }, 1, t);
  }
}

class Ocean extends Sound {
  static level = 1.3;

  start(t) {
    this.bus = this.gain(1);
    this.bus.connect(this.out);
    this.send(this.bus, 0.15);
    this.chain(this.loop(this.sh.noise('brown'), t), this.filter('lowpass', 380), this.gain(0.3), this.bus);
    this.ev = { next: t + 0.05 };
  }

  schedule(until) {
    this.each(this.ev, until, (t) => {
      const D = rand(7, 12);
      this.wave(t, D);
      return D * rand(0.5, 0.75);
    });
  }

  wave(t, D) {
    const peak = rand(0.45, 1), crest = rand(0.38, 0.5), fHi = rand(1100, 2400) * (0.6 + 0.4 * peak);
    const N = 128, env = new Float32Array(N), cut = new Float32Array(N), foam = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      let e;
      if (x < crest) e = Math.sin(((x / crest) * Math.PI) / 2) ** 3;
      else {
        const u = (x - crest) / (1 - crest);
        e = Math.exp(-3 * u) * (1 - u);
      }
      env[i] = e * peak;
      cut[i] = 260 + fHi * e ** 1.4;
      // foam hisses up as the wave breaks and drains away slowly
      const u = (x - crest * 0.95) / (1 - crest * 0.95);
      foam[i] = u > 0 ? (1 - Math.exp(-u * 30)) * Math.exp(-u * 2.5) * (1 - u) * peak * 0.35 : 0;
    }
    const pan = this.pan(rand(-0.45, 0.45));
    pan.connect(this.bus);
    const lp = this.filter('lowpass', 260, 0.5);
    lp.frequency.setValueCurveAtTime(cut, t, D);
    const g = this.gain(0);
    g.gain.setValueCurveAtTime(env, t, D);
    this.chain(this.source(this.sh.noise('pink'), t, D), lp, g, pan);
    const fg = this.gain(0);
    fg.gain.setValueCurveAtTime(foam, t, D);
    this.chain(this.source(this.sh.noise('white'), t, D), this.filter('highpass', 2200), this.filter('lowpass', 9000), fg, pan);
  }
}

class River extends Sound {
  static level = 1.19;

  start(t) {
    const sh = this.sh, bus = this.gain(1);
    bus.connect(this.out);
    this.send(bus, 0.12);
    const bp = this.filter('bandpass', rand(700, 950), 0.6);
    this.modulate(bp.frequency, this.lfo(t, 3, 0.05, 0.2), 180);
    this.chain(this.loop(sh.noise('pink'), t), bp, this.gain(0.5), bus);
    this.chain(this.loop(sh.noise('brown'), t), this.filter('lowpass', 500), this.gain(0.3), bus);
    const babble = this.gain(0.8);
    babble.connect(bus);
    this.modulate(babble.gain, this.lfo(t, 3, 0.1, 0.4), 0.3);
    for (const [sec, p] of [[6.1, -0.6], [8.3, 0.6], [7.3, 0]]) {
      const buf = eventLoop(this.ctx, sec, Math.round(sec * 40), drawBubble(320, 1500));
      this.chain(this.loop(buf, t), this.pan(p), babble);
    }
  }
}

class Waterfall extends Sound {
  static level = 0.65;

  start(t) {
    const sh = this.sh, bus = this.gain(1);
    bus.connect(this.out);
    this.send(bus, 0.2);
    this.modulate(bus.gain, this.lfo(t, 3, 0.03, 0.12), 0.08);
    this.chain(this.loop(sh.noise('pink'), t), this.filter('lowpass', 3200), this.gain(0.8), bus);
    this.chain(this.loop(sh.noise('white'), t), this.filter('bandpass', 2000, 0.5), this.gain(0.12), bus);
    this.chain(this.loop(sh.noise('brown'), t), this.filter('lowpass', 220), this.gain(0.8), bus);
    for (const [sec, p] of [[4.7, -0.5], [5.9, 0.5]]) {
      const buf = eventLoop(this.ctx, sec, Math.round(sec * 120), drawBubble(500, 2600, 0.5));
      this.chain(this.loop(buf, t), this.pan(p), this.gain(0.6), bus);
    }
  }
}

class Drops extends Sound {
  static level = 1.13;

  start(t) {
    this.bus = this.gain(1);
    this.bus.connect(this.out);
    this.send(this.bus, 1);
    // a few steady drips, like water falling from fixed points in a cave
    this.drips = Array.from({ length: 3 }, () => ({
      next: t + rand(0.1, 2),
      period: rand(1.1, 3.8),
      f: rand(650, 1500),
      p: rand(-0.7, 0.7),
      a: rand(0.5, 1),
    }));
    this.stray = { next: t + rand(1, 4) };
  }

  schedule(until) {
    for (const d of this.drips) {
      this.each(d, until, (t) => {
        this.drop(t, d.f * rand(0.97, 1.03), d.p, d.a * rand(0.7, 1));
        if (chance(0.02)) d.period = rand(1.1, 3.8);
        return d.period * rand(0.92, 1.08);
      });
    }
    this.each(this.stray, until, (t) => {
      this.drop(t, rand(500, 1800), rand(-0.9, 0.9), rand(0.2, 0.6));
      return rand(0.4, 5);
    });
  }

  drop(t, f, p, a) {
    const o = this.ctx.createOscillator(), g = this.gain(0);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rand(1.5, 2.3), t + rand(0.03, 0.07));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, rand(0.012, 0.03));
    this.chain(o, g, this.pan(p), this.bus);
    o.start(t);
    o.stop(t + 0.3);
  }
}

class Fire extends Sound {
  static level = 1.5;

  start(t) {
    const sh = this.sh, bus = this.gain(1);
    bus.connect(this.out);
    this.send(bus, 0.1);
    const roar = this.gain(0.45);
    this.modulate(roar.gain, this.lfo(t, 4, 0.3, 2.5), 0.15);
    this.chain(this.loop(sh.noise('brown'), t), this.filter('lowpass', 300), roar, bus);
    const hiss = this.gain(0.03);
    this.modulate(hiss.gain, this.lfo(t, 3, 0.1, 0.5), 0.015);
    this.chain(this.loop(sh.noise('white'), t), this.filter('bandpass', 3500, 0.8), hiss, bus);
    for (const [sec, p] of [[7.3, -0.4], [9.7, 0.4], [12.1, 0]]) {
      const buf = eventLoop(this.ctx, sec, Math.round(sec * 3.5), drawCrackle);
      this.chain(this.loop(buf, t), this.pan(p), bus);
    }
  }
}

class Crickets extends Sound {
  static level = 1.24;

  start(t) {
    const bus = this.gain(1);
    bus.connect(this.out);
    this.send(bus, 0.25);
    for (let i = 0; i < 7; i++) {
      const far = i >= 4;
      const buf = cricketLoop(this.ctx, {
        f: far ? rand(2700, 3500) : rand(3900, 4900),
        period: rand(0.38, 0.9),
        reps: randInt(7, 13),
        pulses: far ? randInt(6, 10) : randInt(3, 5),
        pulseDur: rand(0.011, 0.017),
        pulseGap: rand(0.01, 0.017),
      });
      const nodes = [this.loop(buf, t), this.gain(far ? rand(0.12, 0.25) : rand(0.35, 0.8))];
      if (far) nodes.push(this.filter('lowpass', 3800));
      this.chain(...nodes, this.pan(rand(-0.85, 0.85)), bus);
    }
  }
}

/* Birds: each bird gets its own procedurally generated song and repeats it with variations. */

function syllable() {
  const r = Math.random();
  if (r < 0.28) return { dur: rand(0.08, 0.3), f0: rand(1800, 4000), f1: rand(1800, 4400), vib: chance(0.3) ? rand(20, 35) : 0, depth: rand(0.02, 0.06) }; // whistle
  if (r < 0.48) return { dur: rand(0.025, 0.06), f0: rand(4500, 6500), f1: rand(2200, 3400) }; // chip
  if (r < 0.68) return { trill: randInt(4, 10), dur: rand(0.02, 0.045), gap: rand(0.012, 0.03), f0: rand(3000, 5200), f1: rand(2400, 4200), drift: rand(0.8, 1.15) };
  if (r < 0.84) return { dur: rand(0.15, 0.35), f0: rand(2200, 3200), f1: rand(2200, 3200), vib: rand(18, 40), depth: rand(0.05, 0.12) }; // warble
  return { dur: rand(0.05, 0.12), f0: rand(2000, 3000), f1: rand(3800, 5500) }; // up-slur
}

function song() {
  const notes = [];
  for (let i = randInt(2, 5); i > 0; i--) {
    const s = syllable();
    for (let r = chance(0.4) ? randInt(2, 4) : 1; r > 0; r--) notes.push({ s, gap: rand(0.03, 0.12) });
  }
  return notes;
}

const BIRD_ENV = Float32Array.from({ length: 32 }, (_, i) => Math.sin((Math.PI * i) / 31) ** 1.3 * (1 - (0.3 * i) / 31));

class Birds extends Sound {
  static level = 1.5;

  start(t) {
    this.birds = Array.from({ length: 5 }, () => {
      const dist = Math.random();
      const g = this.gain(0.7 - 0.5 * dist);
      const pan = this.pan(rand(-0.85, 0.85));
      this.chain(g, this.filter('lowpass', 9000 - 5000 * dist), pan, this.out);
      this.send(pan, 0.15 + 0.35 * dist);
      return { g, songs: [song(), song()], pitch: rand(0.85, 1.15), rest: rand(3, 9), ev: { next: t + rand(0.3, 4) } };
    });
  }

  schedule(until) {
    for (const b of this.birds) {
      this.each(b.ev, until, (t) => {
        const dur = this.sing(b, pick(b.songs), t);
        return dur + b.rest * rand(0.5, 1.6) + (chance(0.15) ? rand(8, 25) : 0);
      });
    }
  }

  sing(b, notes, t) {
    const k = b.pitch * rand(0.97, 1.03), tempo = rand(0.93, 1.07);
    let tt = t;
    for (const { s, gap } of notes) {
      if (s.trill) {
        for (let i = 0; i < s.trill; i++) {
          const drift = s.drift ** (i / s.trill);
          this.tone(tt, s.dur * tempo, s.f0 * k * drift, s.f1 * k * drift, 0, 0, b.g, 0.8);
          tt += (s.dur + s.gap) * tempo;
        }
      } else {
        this.tone(tt, s.dur * tempo, s.f0 * k, s.f1 * k, s.vib, s.depth, b.g, 1);
        tt += s.dur * tempo;
      }
      tt += gap * tempo;
    }
    return tt - t;
  }

  tone(t, d, f0, f1, vib, depth, dest, amp) {
    const o = this.ctx.createOscillator(), g = this.gain(0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + d);
    if (vib) {
      const m = this.ctx.createOscillator();
      m.frequency.value = vib;
      this.chain(m, this.gain(f0 * depth), o.frequency);
      m.start(t);
      m.stop(t + d + 0.02);
    }
    g.gain.setValueCurveAtTime(BIRD_ENV.map((v) => v * amp * 0.25), t, d);
    this.chain(o, g, dest);
    o.start(t);
    o.stop(t + d + 0.02);
  }
}

const CHIME_SCALES = {
  Pentatonic: [523.25, 587.33, 659.26, 783.99, 880.0, 1046.5],
  Minor: [440.0, 523.25, 587.33, 659.26, 783.99, 880.0],
  Deep: [220.0, 261.63, 293.66, 329.63, 392.0, 440.0],
  High: [1318.51, 1567.98, 1760.0, 1975.53, 2349.32, 2637.02],
};

class Chimes extends Sound {
  static level = 0.84;

  start(t) {
    const scale = CHIME_SCALES[this.opts.scale] ?? CHIME_SCALES.Pentatonic;
    this.tubes = scale.map((f, i) => {
      const p = this.pan(-0.6 + (1.2 * i) / (scale.length - 1));
      p.connect(this.out);
      this.send(p, 0.35);
      return { f, p };
    });
    this.idx = randInt(0, scale.length - 1);
    this.ev = { next: t + rand(0.2, 1) };
  }

  schedule(until) {
    // a breeze sets off a little cluster of strikes, then it's quiet for a while
    this.each(this.ev, until, (t) => {
      let tt = t;
      for (let n = 1 + Math.floor(Math.random() ** 1.6 * 6); n > 0; n--) {
        this.idx = chance(0.25)
          ? randInt(0, this.tubes.length - 1)
          : clamp(this.idx + pick([-2, -1, 1, 2]), 0, this.tubes.length - 1);
        this.strike(this.tubes[this.idx], tt, rand(0.25, 1) ** 1.3);
        tt += rand(0.09, 0.55);
      }
      return tt - t + rand(1.5, 4) + Math.random() * Math.random() * 12;
    });
  }

  strike(tube, t, vel) {
    const f = tube.f * rand(0.998, 1.002);
    const T = clamp(9 * Math.sqrt(440 / f), 2.5, 14);
    // free-free bar modes of a tubular chime
    for (const [r, a] of [[1, 1], [2.756, 0.45], [5.404, 0.22], [8.933, 0.1]]) {
      if (f * r > this.ctx.sampleRate * 0.45) continue;
      const dur = T / r ** 0.8;
      this.ring(t, f * r, a * vel * 0.3, dur, tube.p);
      if (r === 1) this.ring(t, f + rand(0.3, 0.9), a * vel * 0.12, dur, tube.p);
    }
  }
}

class Bowl extends Sound {
  static level = 0.89;

  start(t) {
    const base = [146.83, 174.61, 196.0, 220.0, 261.63];
    const i = randInt(0, base.length - 2);
    this.bowls = [base[i], base[i + 1]];
    this.ev = { next: t + 0.2 };
  }

  schedule(until) {
    this.each(this.ev, until, (t) => {
      this.strike(t);
      return rand(14, 28);
    });
  }

  strike(t) {
    const f0 = pick(this.bowls) * rand(0.997, 1.003), vel = rand(0.6, 1), T = rand(22, 32);
    const pan = this.pan(rand(-0.3, 0.3));
    pan.connect(this.out);
    this.send(pan, 0.35);
    // each mode is split into two close frequencies, which gives the slow "wah-wah" beating
    [[1, 1], [2.72, 0.55], [5.18, 0.3], [8.25, 0.12], [11.8, 0.06]].forEach(([r, a], k) => {
      const f = f0 * r;
      if (f > this.ctx.sampleRate * 0.45) return;
      const beat = rand(0.4, 1.4) * (1 + k * 0.6);
      const dur = T / r ** 0.85;
      this.ring(t, f - beat / 2, a * vel * 0.2, dur, pan, 0.005);
      this.ring(t, f + beat / 2, a * vel * 0.2, dur, pan, 0.005);
    });
    // soft mallet thump
    const g = this.gain(0);
    g.gain.setValueAtTime(0.25 * vel, t);
    g.gain.setTargetAtTime(0, t, 0.012);
    this.chain(this.source(this.sh.noise('pink'), t, 0.1), this.filter('lowpass', 1200), g, pan);
  }
}

class Drone extends Sound {
  static level = 0.52;

  start(t) {
    const f = 98; // G2
    const mix = this.gain(1), bus = this.gain(1);
    bus.connect(this.out);
    this.send(bus, 0.4);
    this.modulate(bus.gain, this.lfo(t, 2, 0.04, 0.1), 0.2);
    for (const [m, cents, a] of [[1, 0, 0.5], [1, 7, 0.4], [1, -6, 0.4], [2, 3, 0.2], [1.5, -3, 0.12]]) {
      this.chain(this.osc(f * m * 2 ** (cents / 1200), t, 'sawtooth'), this.gain(a), mix);
    }
    this.chain(this.osc(f / 2, t), this.gain(0.35), bus);
    // vowel-like formants slowly drifting between "oo" and "oh"
    for (const [ff, q, a] of [[420, 6, 1], [820, 8, 0.5], [2600, 12, 0.12]]) {
      const bp = this.filter('bandpass', ff, q);
      this.modulate(bp.frequency, this.lfo(t, 2, 0.02, 0.07), ff * 0.15);
      this.chain(mix, bp, this.gain(a), bus);
    }
    this.chain(mix, this.filter('lowpass', 300), this.gain(0.25), bus);
  }
}

const BEATS = { 'Theta 6 Hz': 6, 'Alpha 10 Hz': 10, 'Delta 3 Hz': 3 };

class Binaural extends Sound {
  static level = 0.18;

  start(t) {
    const beat = this.opts.beat ?? 6, fc = 200;
    const merge = this.ctx.createChannelMerger(2);
    this.osc(fc - beat / 2, t).connect(this.gain(0.5)).connect(merge, 0, 0);
    this.osc(fc + beat / 2, t).connect(this.gain(0.5)).connect(merge, 0, 1);
    merge.connect(this.out);
  }
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export const SOUNDS = [
  { id: 'rain', name: 'Rain', make: (sh) => new Rain(sh) },
  { id: 'thunder', name: 'Thunder', make: (sh) => new Thunder(sh) },
  { id: 'storm', name: 'Storm', make: (sh) => new Storm(sh) },
  { id: 'wind', name: 'Wind', make: (sh) => new Wind(sh) },
  { id: 'ocean', name: 'Ocean', make: (sh) => new Ocean(sh) },
  { id: 'river', name: 'River', make: (sh) => new River(sh) },
  { id: 'waterfall', name: 'Waterfall', make: (sh) => new Waterfall(sh) },
  { id: 'drops', name: 'Cave drips', make: (sh) => new Drops(sh) },
  { id: 'fire', name: 'Campfire', make: (sh) => new Fire(sh) },
  { id: 'birds', name: 'Birds', make: (sh) => new Birds(sh) },
  { id: 'crickets', name: 'Crickets', make: (sh) => new Crickets(sh) },
  { id: 'chimes', name: 'Wind chimes', variants: Object.keys(CHIME_SCALES), make: (sh, v) => new Chimes(sh, { scale: v }) },
  { id: 'bowl', name: 'Singing bowl', make: (sh) => new Bowl(sh) },
  { id: 'drone', name: 'Drone', make: (sh) => new Drone(sh) },
  { id: 'binaural', name: 'Binaural', variants: Object.keys(BEATS), make: (sh, v) => new Binaural(sh, { beat: BEATS[v] }) },
  { id: 'white', name: 'White noise', make: (sh) => new Noise(sh, { color: 'white', level: 0.3 }) },
  { id: 'pink', name: 'Pink noise', make: (sh) => new Noise(sh, { color: 'pink', level: 0.54 }) },
  { id: 'brown', name: 'Brown noise', make: (sh) => new Noise(sh, { color: 'brown', level: 0.66 }) },
];

const BY_ID = Object.fromEntries(SOUNDS.map((s) => [s.id, s]));

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
    // Events are scheduled ahead; further ahead while hidden, where timers are throttled.
    setInterval(() => this.tick(), 250);
    document.addEventListener('visibilitychange', () => this.tick());
  }

  tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const until = ctx.currentTime + (document.hidden ? 12 : 2.5);
    for (const v of this.voices.values()) v.sound.schedule(until);
  }

  has(id) {
    return this.voices.has(id);
  }

  enable(id, volume, variant) {
    if (!this.ctx || this.voices.has(id)) return;
    const t = this.ctx.currentTime + 0.05;
    const sound = BY_ID[id].make(this.sh, variant);
    const dry = this.ctx.createGain(), wet = this.ctx.createGain();
    sound.out.connect(dry).connect(this.input);
    sound.wet.connect(wet).connect(this.sh.verbIn);
    for (const g of [dry, wet]) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(volumeToGain(volume), t + 1.5);
    }
    sound.start(t);
    sound.schedule(t + 2.5);
    this.voices.set(id, { sound, dry, wet, volume });
  }

  disable(id, fade = 1.2) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    const t = this.ctx.currentTime;
    for (const g of [v.dry, v.wet]) this.ramp(g.gain, 0, t, fade);
    v.sound.stop(t + fade + 0.1);
    setTimeout(() => {
      v.dry.disconnect();
      v.wet.disconnect();
    }, (fade + 0.5) * 1000);
  }

  setVolume(id, volume) {
    const v = this.voices.get(id);
    if (!v) return;
    v.volume = volume;
    for (const g of [v.dry, v.wet]) this.ramp(g.gain, volumeToGain(volume), this.ctx.currentTime, 0.08);
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
    resumed.then(() => this.tick()).catch(() => {});
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
