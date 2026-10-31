// AudioWorklet processor that synthesises every sound sample by sample.
// Everything is driven by random processes, so nothing loops and nothing repeats.
//
// Techniques:
//  - A. Farnell, "Designing Sound" (MIT Press): fire, wind, rain, running water.
//  - K. van den Doel, "Physically based models for liquid sounds" (2005): bubbles
//    with Minnaert resonance, damping and rising pitch.
//  - S. Liu et al., "Physically-based statistical simulation of rain sound" (2019):
//    drops as an impact plus, on water, a bubble.
//  - H. Ribner & D. Roy, "Acoustics of thunder" (1982): thunder as the sum of
//    N-waves from every segment of a tortuous lightning channel.

const SR = sampleRate;
const NYQ = SR / 2;
const TAU = 2 * Math.PI;
const rnd = Math.random;
const range = (a, b) => a + rnd() * (b - a);
const irange = (a, b) => Math.floor(range(a, b + 1));
const logRange = (a, b) => a * (b / a) ** rnd();
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const white = () => rnd() * 2 - 1;
const expo = (mean) => -Math.log(1 - rnd()) * mean;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (x) => x * x * (3 - 2 * x);
const samples = (s) => Math.max(1, Math.round(s * SR));

function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = rnd();
  while (p > L) {
    k++;
    p *= rnd();
  }
  return k;
}

// Equal-power pan plus reverb send, stored on the object.
function setPan(v, pan, wet) {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  v.gl = Math.cos(a);
  v.gr = Math.sin(a);
  v.wl = v.gl * wet;
  v.wr = v.gr * wet;
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

class OnePole {
  constructor(fc) {
    this.y = 0;
    this.set(fc);
  }
  set(fc) {
    this.a = 1 - Math.exp((-TAU * fc) / SR);
  }
  lp(x) {
    return (this.y += this.a * (x - this.y));
  }
  hp(x) {
    return x - this.lp(x);
  }
}

// Topology-preserving state-variable filter (Simper); stays stable while modulated.
// After run(): .lp, .bp (unity peak gain) and .hp.
class SVF {
  constructor(fc = 1000, q = 0.707) {
    this.s1 = this.s2 = this.lp = this.bp = this.hp = 0;
    this.set(fc, q);
  }
  set(fc, q) {
    const g = Math.tan((Math.PI * clamp(fc, 10, NYQ * 0.9)) / SR), k = 1 / q;
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  reset() {
    this.s1 = this.s2 = 0;
  }
  run(x) {
    const v3 = x - this.s2;
    const v1 = this.a1 * this.s1 + this.a2 * v3;
    const v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
    this.s1 = 2 * v1 - this.s1;
    this.s2 = 2 * v2 - this.s2;
    this.lp = v2;
    this.bp = this.k * v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

// Paul Kellet's pink noise filter.
class Pink {
  constructor() {
    this.b0 = this.b1 = this.b2 = this.b3 = this.b4 = this.b5 = this.b6 = 0;
  }
  next() {
    const w = white();
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.2;
  }
}

class Brown {
  constructor() {
    this.l = 0;
  }
  next() {
    this.l = (this.l + 0.02 * white()) / 1.02;
    return this.l * 3.5;
  }
}

// Smooth, aperiodic random motion: glides between random targets over random durations.
class Wander {
  constructor(minSec, maxSec, lo = -1, hi = 1) {
    this.min = minSec;
    this.max = maxSec;
    this.lo = lo;
    this.hi = hi;
    this.a = this.b = this.v = range(lo, hi);
    this.p = 1;
    this.inc = 1;
  }
  next(steps = 1) {
    this.p += this.inc * steps;
    if (this.p >= 1) {
      this.p = 0;
      this.a = this.b;
      this.b = range(this.lo, this.hi);
      this.inc = 1 / (range(this.min, this.max) * SR);
    }
    return (this.v = this.a + (this.b - this.a) * smooth(this.p));
  }
}

// Random swells (gusts, surges): rise, then decay, starting again at random times.
class Gusts {
  constructor(meanGap, attack, decay, peak) {
    this.meanGap = meanGap;
    this.attack = attack;
    this.decay = decay;
    this.peak = peak;
    this.v = 0;
    this.wait = samples(expo(meanGap));
    this.t = 0;
    this.att = 1;
    this.dec = 1;
    this.from = 0;
    this.to = 0;
  }
  next(steps = 1) {
    this.wait -= steps;
    if (this.wait <= 0) {
      this.wait = samples(expo(this.meanGap));
      this.from = this.v;
      this.to = range(this.peak[0], this.peak[1]);
      this.t = 0;
      this.att = samples(range(this.attack[0], this.attack[1]));
      this.dec = range(this.decay[0], this.decay[1]) * SR;
    }
    this.t += steps;
    this.v =
      this.t < this.att
        ? this.from + (this.to - this.from) * smooth(this.t / this.att)
        : this.to * Math.exp(-(this.t - this.att) / this.dec);
    return this.v;
  }
}

// Fires events at random (Poisson) times at rate `r` per second.
class Clock {
  constructor(rate) {
    this.r = rate;
    this.t = samples(expo(1 / rate));
  }
  run(n, fire) {
    while (this.t < n) {
      fire(this.t);
      this.t += samples(expo(1 / this.r));
    }
    this.t -= n;
  }
}

// A two-pole resonator: one mode of a struck object (chime tube, bowl).
class Mode {
  constructor(f, t60, amp) {
    const R = Math.exp(-6.9 / (t60 * SR)), w = (TAU * f) / SR;
    this.c1 = 2 * R * Math.cos(w);
    this.c2 = -R * R;
    this.gain = Math.sin(w) * amp;
    this.y1 = this.y2 = 0;
  }
  tick(x) {
    const y = this.c1 * this.y1 + this.c2 * this.y2 + x * this.gain;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/* ------------------------------------------------------------------ */
/* Voices                                                              */
/* ------------------------------------------------------------------ */

// Voices can start in a later block: `off` counts down until they begin.
class Pool {
  constructor(Voice, size) {
    this.free = Array.from({ length: size }, () => new Voice());
    this.active = [];
  }
  spawn() {
    const v = this.free.pop();
    if (v) this.active.push(v);
    return v;
  }
  render(L, R, WL, WR, n) {
    const a = this.active;
    for (let k = a.length - 1; k >= 0; k--) {
      if (!a[k].render(L, R, WL, WR, n)) {
        this.free.push(a[k]);
        a[k] = a[a.length - 1];
        a.pop();
      }
    }
  }
}

// Damped sine with rising pitch: a bubble, a drip, a rain plink.
class Ping {
  init(off, f0, damping, rise, amp, pan, wet) {
    this.off = off;
    this.ph = 0;
    this.w = (TAU * f0) / SR;
    this.dw = (this.w * rise) / SR;
    this.g = Math.exp(-damping / SR);
    this.a = amp;
    this.k = 0;
    this.kInc = 1 / samples(Math.max(0.0004, 1 / f0));
    this.len = Math.min(samples(7 / damping), samples(1.5));
    setPan(this, pan, wet);
    return this;
  }
  render(L, R, WL, WR, n) {
    if (this.off >= n) {
      this.off -= n;
      return true;
    }
    const end = Math.min(n, this.off + this.len);
    for (let i = this.off; i < end; i++) {
      const s = Math.sin(this.ph) * this.a * (this.k < 1 ? (this.k += this.kInc) : 1);
      this.ph += this.w;
      this.w += this.dw;
      this.a *= this.g;
      L[i] += s * this.gl;
      R[i] += s * this.gr;
      WL[i] += s * this.wl;
      WR[i] += s * this.wr;
    }
    this.len -= end - this.off;
    this.off = 0;
    return this.len > 0 && this.w < 2.8;
  }
}

// A van den Doel bubble: Minnaert frequency f0, physical damping, pitch rising by xi.
function bubble(pool, off, f0, amp, pan, wet, xi = 0.1) {
  const d = 0.13 * f0 + 0.0072 * f0 ** 1.5;
  pool.spawn()?.init(off, f0, d, xi * d, amp, pan, wet);
}

// Short band-passed noise burst with exponential decay: crackles, drop impacts.
class Burst {
  constructor() {
    this.f = new SVF(1000, 1);
  }
  init(off, fc, q, tau, amp, pan, wet) {
    this.off = off;
    this.f.reset();
    this.f.set(fc, q);
    this.g = Math.exp(-1 / (tau * SR));
    this.a = amp;
    this.len = samples(tau * 7);
    setPan(this, pan, wet);
    return this;
  }
  render(L, R, WL, WR, n) {
    if (this.off >= n) {
      this.off -= n;
      return true;
    }
    const end = Math.min(n, this.off + this.len);
    for (let i = this.off; i < end; i++) {
      this.f.run(white());
      const s = this.f.bp * this.a;
      this.a *= this.g;
      L[i] += s * this.gl;
      R[i] += s * this.gr;
      WL[i] += s * this.wl;
      WR[i] += s * this.wr;
    }
    this.len -= end - this.off;
    this.off = 0;
    return this.len > 0;
  }
}

// Longer filtered-noise event whose loudness, brightness and position follow an
// envelope: waves crashing, foam, backwash. Can sprinkle bubble grains (fizz).
class Swash {
  constructor() {
    this.f = new SVF(500, 0.7);
    this.pink = new Pink();
    this.brown = new Brown();
  }
  init(o) {
    this.off = o.at;
    this.len = samples(o.dur);
    this.att = samples(o.attack);
    this.tau = o.tau * SR;
    this.amp = o.amp;
    this.color = o.color;
    this.type = o.type;
    this.f0 = o.f0;
    this.f1 = o.f1;
    this.q = o.q ?? 0.7;
    this.gamma = o.gamma ?? 1.3;
    this.pan0 = o.pan0;
    this.pan1 = o.pan1 ?? o.pan0;
    this.wet = o.wet ?? 0.1;
    this.fizz = o.fizz ?? 0;
    this.grains = o.grains;
    this.i = 0;
    this.g = 0;
    this.gt = 0;
    this.f.reset();
    return this;
  }
  control(at) {
    const t = this.i;
    let e = t < this.att ? smooth(t / this.att) : Math.exp(-(t - this.att) / this.tau);
    const rem = (this.len - t) / SR;
    if (rem < 1) e *= rem;
    this.gt = e * this.amp;
    this.f.set(this.f0 + (this.f1 - this.f0) * e ** this.gamma, this.q);
    setPan(this, this.pan0 + ((this.pan1 - this.pan0) * t) / this.len, this.wet);
    if (this.fizz) {
      // foam: countless tiny bubbles bursting, denser while the wash is loud
      for (let k = poisson((this.fizz * e * 32) / SR); k > 0; k--) {
        const f0 = logRange(1800, 9000);
        bubble(this.grains, at + Math.floor(rnd() * 32), f0, range(0.004, 0.03) * this.amp * 3, this.pan0 + range(-0.5, 0.5), this.wet, 0.1);
      }
    }
  }
  render(L, R, WL, WR, n) {
    if (this.off >= n) {
      this.off -= n;
      return true;
    }
    for (let i = this.off; i < n && this.i < this.len; i++, this.i++) {
      if ((this.i & 31) === 0) this.control(i);
      const x = this.color === 'white' ? white() : this.color === 'pink' ? this.pink.next() : this.brown.next();
      this.f.run(x);
      this.g += (this.gt - this.g) * 0.02;
      const s = (this.type === 'lp' ? this.f.lp : this.type === 'bp' ? this.f.bp : this.f.hp) * this.g;
      L[i] += s * this.gl;
      R[i] += s * this.gr;
      WL[i] += s * this.wl;
      WR[i] += s * this.wr;
    }
    this.off = 0;
    return this.i < this.len;
  }
}

/* ------------------------------------------------------------------ */
/* Generators                                                          */
/* ------------------------------------------------------------------ */

class Gen {
  constructor() {
    this.queue = [];
    this.tmp = [0, 1, 2, 3].map(() => new Float32Array(128));
  }
  // Run fn(offset) `delay` samples after the start of the current block.
  after(delay, fn) {
    this.queue.push({ t: delay, fn });
  }
  runQueue(n) {
    const q = this.queue;
    for (let k = q.length - 1; k >= 0; k--) {
      const e = q[k];
      if (e.t < n) {
        q.splice(k, 1);
        e.fn(Math.max(0, Math.floor(e.t)));
      } else e.t -= n;
    }
  }
  // Renders a sub-generator at a given gain (for Storm).
  mix(gen, gain, L, R, WL, WR, n) {
    const [a, b, c, d] = this.tmp;
    a.fill(0);
    b.fill(0);
    c.fill(0);
    d.fill(0);
    gen.render(a, b, c, d, n);
    for (let i = 0; i < n; i++) {
      L[i] += a[i] * gain;
      R[i] += b[i] * gain;
      WL[i] += c[i] * gain;
      WR[i] += d[i] * gain;
    }
  }
}

/* ---------- noise ---------- */

class WhiteNoise extends Gen {
  render(L, R, WL, WR, n) {
    for (let i = 0; i < n; i++) {
      L[i] += white() * 0.4;
      R[i] += white() * 0.4;
    }
  }
}

class PinkNoise extends Gen {
  constructor() {
    super();
    this.a = new Pink();
    this.b = new Pink();
  }
  render(L, R, WL, WR, n) {
    for (let i = 0; i < n; i++) {
      L[i] += this.a.next();
      R[i] += this.b.next();
    }
  }
}

class BrownNoise extends Gen {
  constructor() {
    super();
    this.a = new Brown();
    this.b = new Brown();
    this.ha = new OnePole(25);
    this.hb = new OnePole(25);
  }
  render(L, R, WL, WR, n) {
    for (let i = 0; i < n; i++) {
      L[i] += this.ha.hp(this.a.next());
      R[i] += this.hb.hp(this.b.next());
    }
  }
}

/* ---------- campfire ---------- */

// One of Farnell's fire generators: "lapping" (clipped 30 Hz band of noise) and
// "hissing" (noise gated by the 4th power of a slow random signal), coloured by
// its own filter so that several of them make a fire with body and width.
class Flame {
  constructor(type, fc, q, pan) {
    this.lap = new SVF(30, 5);
    this.hp1 = new OnePole(25);
    this.hp2 = new OnePole(25);
    this.mod = new OnePole(1);
    this.hissHP = new OnePole(1000);
    this.color = new SVF(fc, q);
    this.type = type;
    setPan(this, pan, 0);
  }
  next() {
    this.lap.run(white());
    let lap = this.hp1.hp(this.lap.bp * 100);
    lap = lap > 0.9 ? 0.9 : lap < -0.9 ? -0.9 : lap;
    lap = this.hp2.hp(lap) * 0.6;
    const m = this.mod.lp(white()) * 10, m2 = m * m;
    const hiss = this.hissHP.hp(white()) * m2 * m2 * 600 * 0.3;
    this.color.run(lap + hiss);
    return this.type === 'hp' ? this.color.hp : this.color.bp;
  }
}

class Fire extends Gen {
  constructor() {
    super();
    this.flames = [
      new Flame('bp', 1200, 0.6, -0.45),
      new Flame('bp', 2600, 0.4, 0.35),
      new Flame('hp', 1000, 0.7, -0.1),
      new Flame('bp', 600, 0.2, 0.5),
    ];
    this.roar = [new Brown(), new Brown()];
    this.roarLP = [new OnePole(200), new OnePole(200)];
    this.roarAmt = new Wander(0.25, 1.5, 0.3, 1);
    this.heat = new Wander(0.3, 2.5, 0, 1); // crackling comes in clusters
    this.crackles = new Pool(Burst, 64);
    this.clock = new Clock(45);
    this.popClock = new Clock(0.12);
  }
  render(L, R, WL, WR, n) {
    this.runQueue(n);
    for (let i = 0; i < n; i++) {
      let l = 0, r = 0;
      for (let k = 0; k < 4; k++) {
        const f = this.flames[k], s = f.next();
        l += s * f.gl;
        r += s * f.gr;
      }
      const ra = this.roarAmt.next() * 0.35;
      L[i] += l * 0.2 + this.roarLP[0].lp(this.roar[0].next()) * ra;
      R[i] += r * 0.2 + this.roarLP[1].lp(this.roar[1].next()) * ra;
      WL[i] += l * 0.02;
      WR[i] += r * 0.02;
    }
    const h = this.heat.next(n) ** 3;
    this.clock.run(n, (o) => chance(0.04 + 0.96 * h) && this.crackle(o, 1));
    this.popClock.run(n, (o) => this.pop(o));
    this.crackles.render(L, R, WL, WR, n);
  }
  // Farnell: a random length d (ms) sets both the decay and the band (1.5 kHz + 500·d).
  crackle(o, scale) {
    const d = range(0.6, 29);
    const amp = (0.04 + 0.5 * rnd() ** 3) * scale;
    this.crackles.spawn()?.init(o, Math.min(1500 + 500 * d, NYQ * 0.8), 1, d / 3000, amp, range(-0.7, 0.7), 0.06);
  }
  // A knot bursting: a louder, lower pop, often followed by a sizzle of tiny crackles.
  pop(o) {
    const pan = range(-0.6, 0.6);
    this.crackles.spawn()?.init(o, range(350, 1200), range(1.5, 3), range(0.004, 0.012), range(0.4, 0.9), pan, 0.1);
    if (chance(0.6)) {
      for (let k = irange(4, 14); k > 0; k--) {
        this.after(o + samples(range(0.02, 0.4)), (oo) => this.crackle(oo, 0.35));
      }
    }
  }
}

/* ---------- thunder ---------- */

// One strike. The lightning channel is a random walk from the cloud to the ground,
// with branches and in-cloud channels. Every segment emits an N-wave (a shock that
// jumps up, falls linearly and jumps back) heard after distance/343 s. Waves get
// longer and their edges softer with distance; segments perpendicular to the
// listener radiate most strongly, which produces the claps inside the rumble.
class Strike {
  constructor(close) {
    const D = close ? logRange(500, 3500) : logRange(1800, 9000);
    const az = range(-1.2, 1.2);
    const gx = D * Math.sin(az), gy = D * Math.cos(az);
    const H = range(1800, 4000);
    const segs = [];
    const walk = (x, y, z, tx, ty, tz, step, maxSteps, energy, wander) => {
      for (let k = 0; k < maxSteps; k++) {
        let dx = tx - x, dy = ty - y, dz = tz - z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < step) break;
        dx = dx / dist + white() * wander;
        dy = dy / dist + white() * wander;
        dz = dz / dist + white() * wander * 0.6;
        const m = Math.hypot(dx, dy, dz);
        dx /= m;
        dy /= m;
        dz /= m;
        const l = step * range(0.6, 1.4);
        segs.push([x + (dx * l) / 2, y + (dy * l) / 2, Math.max(1, z + (dz * l) / 2), dx, dy, dz, l, energy]);
        x += dx * l;
        y += dy * l;
        z = Math.max(0, z + dz * l);
      }
      return [x, y, z];
    };
    walk(gx + range(-600, 600), gy + range(-600, 600), H, gx, gy, 0, 14, 900, 1, 0.55);
    const main = segs.length;
    for (let b = irange(2, 5); b > 0; b--) {
      const s = segs[Math.floor(rnd() * main * 0.7)];
      walk(s[0], s[1], s[2], s[0] + range(-1200, 1200), s[1] + range(-1200, 1200), Math.max(50, s[2] - range(400, 1500)), 14, 140, range(0.3, 0.6), 0.55);
    }
    for (let c = irange(1, 3); c > 0; c--) {
      const s = segs[Math.floor(rnd() * Math.min(main, 40))];
      const a = range(0, TAU), len = range(1500, 6000);
      walk(s[0], s[1], s[2], s[0] + Math.cos(a) * len, s[1] + Math.sin(a) * len, H + range(-300, 300), 18, 450, range(0.3, 0.7), 0.5);
    }

    // return strokes re-use the main channel a few tens of ms apart
    const strokes = [[0, 1]];
    for (let k = irange(0, 3), t = 0; k > 0; k--) strokes.push([(t += range(0.03, 0.12)), range(0.35, 0.7)]);

    const waves = [];
    segs.forEach((s, idx) => {
      const [mx, my, mz, ux, uy, uz, l, energy] = s;
      const r = Math.hypot(mx, my, mz);
      const cos = Math.abs((ux * mx + uy * my + uz * mz) / r);
      const dir = 0.12 + (1 - cos * cos) ** 3;
      const km = r / 1000;
      const T = range(0.005, 0.011) * (0.6 + 0.4 * energy) * km ** 0.25;
      const rise = Math.min(T * 0.3, 0.00006 + 0.0005 * km);
      const pan = clamp(mx / Math.hypot(mx, my), -1, 1) * 0.85;
      for (const [dt, sa] of idx < main ? strokes : [[0, 1]]) {
        const t = r / 343 + dt, a = (energy * (l / 35) * dir * sa) / km;
        waves.push([t, T, rise, a, pan]);
        // turbulence and terrain scatter each shock into later, longer, softer copies
        for (let k = 0; k < 3; k++) {
          const f = range(1.5, 3);
          waves.push([t + 0.01 + expo(0.12), T * f, Math.min(T * f * 0.3, rise * 3), a * range(0.15, 0.45), clamp(pan + range(-0.4, 0.4), -0.9, 0.9)]);
        }
      }
    });
    waves.sort((a, b) => a[0] - b[0]);
    const t0 = waves[0][0];
    let peak = 0;
    for (const w of waves) peak = Math.max(peak, w[3]);
    const norm = clamp(0.5 * (1000 / D) ** 0.4, 0.12, 0.8) / peak;

    const n = waves.length;
    this.start = new Float64Array(n);
    this.len = new Float64Array(n);
    this.rise = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.gl = new Float64Array(n);
    this.gr = new Float64Array(n);
    const p = {};
    waves.forEach((w, i) => {
      this.start[i] = (w[0] - t0) * SR;
      this.len[i] = w[1] * SR;
      this.rise[i] = Math.max(1, w[2] * SR);
      this.amp[i] = w[3] * norm;
      setPan(p, w[4], 0);
      this.gl[i] = p.gl;
      this.gr[i] = p.gr;
    });
    this.count = n;
    this.ptr = 0;
    this.time = 0;
    this.active = [];
    this.distance = D;
  }
  // Adds this block of the strike to L/R; returns false when it is over.
  render(L, R, n) {
    while (this.ptr < this.count && this.start[this.ptr] < this.time + n) this.active.push(this.ptr++);
    const act = this.active;
    for (let k = act.length - 1; k >= 0; k--) {
      const j = act[k], T = this.len[j], s = this.rise[j], a = this.amp[j], gl = this.gl[j], gr = this.gr[j];
      const st = this.start[j] - this.time;
      const i0 = Math.max(0, Math.ceil(st)), i1 = Math.min(n, Math.floor(st + T) + 1);
      for (let i = i0; i < i1; i++) {
        const tau = i - st;
        let v;
        if (tau < s) v = smooth(tau / s);
        else if (tau < T - s) v = 1 - (2 * (tau - s)) / (T - 2 * s);
        else v = -1 + smooth(Math.min(1, (tau - (T - s)) / s));
        v *= a;
        L[i] += v * gl;
        R[i] += v * gr;
      }
      if (st + T < n) {
        act[k] = act[act.length - 1];
        act.pop();
      }
    }
    this.time += n;
    return this.ptr < this.count || act.length > 0;
  }
}

class Thunder extends Gen {
  constructor(opts = {}) {
    super();
    this.close = !!opts.close;
    this.gap = opts.gap ?? [14, 50];
    this.wait = samples(range(1, 3.5));
    this.strikes = [];
    this.bl = new Float32Array(128);
    this.br = new Float32Array(128);
    // a low rumble that follows how much thunder is arriving
    this.env = 0;
    this.deep = [new Brown(), new Brown()];
    this.deepLP = [new OnePole(90), new OnePole(90)];
    this.mid = [new SVF(180, 0.8), new SVF(180, 0.8)];
    this.midSrc = [new Pink(), new Pink()];
    this.air = [new OnePole(5000), new OnePole(5000)];
    this.dc = [new OnePole(18), new OnePole(18)];
  }
  render(L, R, WL, WR, n) {
    this.wait -= n;
    if (this.wait <= 0) {
      this.strikes.push(new Strike(this.close));
      this.wait = samples(range(this.gap[0], this.gap[1]));
    }
    const bl = this.bl, br = this.br;
    bl.fill(0);
    br.fill(0);
    for (let k = this.strikes.length - 1; k >= 0; k--) {
      if (!this.strikes[k].render(bl, br, n)) this.strikes.splice(k, 1);
    }
    for (let i = 0; i < n; i++) {
      const lvl = Math.abs(bl[i]) + Math.abs(br[i]);
      this.env += (lvl - this.env) * (lvl > this.env ? 0.0005 : 0.00002);
      const e = Math.min(this.env, 1);
      this.mid[0].run(this.midSrc[0].next());
      this.mid[1].run(this.midSrc[1].next());
      const l = this.dc[0].hp(this.air[0].lp(bl[i])) + e * (this.deepLP[0].lp(this.deep[0].next()) * 1.2 + this.mid[0].bp * 0.35);
      const r = this.dc[1].hp(this.air[1].lp(br[i])) + e * (this.deepLP[1].lp(this.deep[1].next()) * 1.2 + this.mid[1].bp * 0.35);
      L[i] += l;
      R[i] += r;
      WL[i] += l * 0.5;
      WR[i] += r * 0.5;
    }
  }
}

/* ---------- rain ---------- */

class Rain extends Gen {
  constructor(opts = {}) {
    super();
    this.heavy = !!opts.heavy;
    this.boost = 1; // raised by the wind in a storm
    this.slow = new Wander(15, 45, 0.75, 1.15);
    this.fast = new Wander(1, 4, 0.9, 1.1);
    // distant drops: thousands of tiny random impulses through two resonant bands
    this.farA = [new SVF(1400, 0.6), new SVF(1400, 0.6)];
    this.farB = [new SVF(4500, 0.7), new SVF(4500, 0.7)];
    this.farHP = [new OnePole(250), new OnePole(250)];
    this.pink = [new Pink(), new Pink()];
    this.brown = [new Brown(), new Brown()];
    this.brownLP = [new OnePole(500), new OnePole(500)];
    this.drops = new Pool(Burst, 96);
    this.plinks = new Pool(Ping, 64);
    this.clock = new Clock(this.heavy ? 900 : 380);
    this.bigClock = new Clock(this.heavy ? 3 : 1.2);
  }
  render(L, R, WL, WR, n) {
    const I = (this.heavy ? 1.6 : 1) * this.slow.next(n) * this.fast.next(n) * this.boost;
    const p = (7000 * I) / SR, pinkAmt = 0.12 * I, brownAmt = this.heavy ? 0.5 * I : 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const imp = rnd() < p ? (rnd() < 0.5 ? -1 : 1) * (0.02 + 0.98 * rnd() ** 4) : 0;
        this.farA[c].run(imp);
        this.farB[c].run(imp);
        let s = this.farHP[c].hp(this.farA[c].bp * 0.6 + this.farB[c].bp) * 1.2 + this.pink[c].next() * pinkAmt;
        if (brownAmt) s += this.brownLP[c].lp(this.brown[c].next()) * brownAmt;
        if (c === 0) {
          L[i] += s;
          WL[i] += s * 0.08;
        } else {
          R[i] += s;
          WR[i] += s * 0.08;
        }
      }
    }
    const accept = I / (this.heavy ? 2.2 : 1.4);
    this.clock.run(n, (o) => chance(accept) && this.drop(o));
    this.bigClock.run(n, (o) => chance(Math.sqrt(accept)) && this.bigDrop(o));
    this.drops.render(L, R, WL, WR, n);
    this.plinks.render(L, R, WL, WR, n);
  }
  // Nearby drops land on different surfaces, each with its own colour.
  drop(o) {
    const r = rnd(), amp = 0.03 + 0.5 * rnd() ** 3, pan = range(-1, 1);
    if (r < 0.4) this.drops.spawn()?.init(o, range(1500, 4500), range(1.5, 4), range(0.001, 0.004), amp, pan, 0.08); // leaves
    else if (r < 0.7) this.drops.spawn()?.init(o, range(350, 1100), 1, range(0.002, 0.006), amp * 1.4, pan, 0.08); // soil
    else if (r < 0.8) this.drops.spawn()?.init(o, range(3000, 7000), 0.8, range(0.0003, 0.001), amp * 0.8, pan, 0.06); // stone
    else {
      // puddle: impact tick, then the ringing bubble it traps
      this.drops.spawn()?.init(o, range(3000, 6000), 1, 0.0005, amp * 0.5, pan, 0.08);
      this.plinks.spawn()?.init(o + samples(0.001), logRange(1500, 6500), range(80, 250), range(5, 20), amp * 0.5, pan, 0.1);
    }
  }
  // Heavy drips falling from leaves and branches.
  bigDrop(o) {
    const pan = range(-0.9, 0.9), amp = range(0.25, 0.6);
    this.drops.spawn()?.init(o, range(500, 1400), 2, range(0.006, 0.015), amp, pan, 0.1);
    if (chance(0.5)) this.plinks.spawn()?.init(o + samples(0.002), range(700, 1600), range(40, 90), 10, amp * 0.5, pan, 0.12);
  }
}

/* ---------- wind ---------- */

// Farnell's wind: a wind-speed signal made of slow drift, gusts and turbulence.
// Every object reads it with its own delay, so a gust sweeps past them one after
// another: broad whooshes, low buffeting, howling edges, a whistling wire and
// rustling leaves.
class Wind extends Gen {
  constructor(opts = {}) {
    super();
    const s = (this.s = opts.strength ?? 1);
    this.base = new Wander(8, 25, 0.18 * s, Math.min(0.85, 0.5 * s));
    this.gusts = new Gusts(9 / s, [0.8, 2.5], [2, 6], [0.1, 0.35 * s]);
    this.turb = new Wander(0.15, 0.6, -0.05, 0.05);
    this.hist = new Float32Array(Math.ceil((3.2 * SR) / 32));
    this.hi = 0;
    this.speed = 0;
    this.pink = [new Pink(), new Pink()];
    this.whoosh = [new SVF(500, 0.7), new SVF(500, 0.7)];
    this.brown = new Brown();
    this.rumble = new OnePole(120);
    this.howl = [new SVF(280, 30), new SVF(430, 30)];
    this.howlBase = [range(250, 320), range(380, 480)];
    this.whistle = new SVF(1200, 60);
    this.leaves = [new SVF(3000, 0.6), new SVF(3000, 0.6)];
    this.g = new Float64Array(6); // smoothed gains
    this.gt = new Float64Array(6);
    this.pLeaves = 0;
  }
  at(sec) {
    const len = this.hist.length;
    return this.hist[(this.hi - Math.round((sec * SR) / 32) + len * 2) % len];
  }
  control() {
    this.speed = clamp(this.base.next(32) + this.gusts.next(32) + this.turb.next(32), 0, 1.2);
    this.hist[(this.hi = (this.hi + 1) % this.hist.length)] = this.speed;
    const a = this.at(0), b = this.at(0.7), h1 = this.at(0.3), h2 = this.at(1.1), w = this.at(0.5), lv = this.at(1.6);
    this.whoosh[0].set(250 + 750 * a, 0.7);
    this.whoosh[1].set(250 + 750 * b, 0.7);
    this.howl[0].set(this.howlBase[0] * (1 + 0.3 * h1), 30);
    this.howl[1].set(this.howlBase[1] * (1 + 0.3 * h2), 30);
    this.whistle.set(900 + 1100 * w * w, 60);
    const gt = this.gt;
    gt[0] = 0.08 + 0.9 * a ** 1.5;
    gt[1] = 0.08 + 0.9 * b ** 1.5;
    gt[2] = 0.7 * this.speed ** 2;
    gt[3] = 14 * Math.max(0, h1 - 0.35) ** 2;
    gt[4] = 14 * Math.max(0, h2 - 0.4) ** 2;
    gt[5] = 22 * Math.max(0, w - 0.55) ** 2;
    this.pLeaves = (3500 * lv * lv) / SR;
  }
  render(L, R, WL, WR, n) {
    const g = this.g, gt = this.gt;
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) this.control();
      for (let k = 0; k < 6; k++) g[k] += (gt[k] - g[k]) * 0.01;
      this.whoosh[0].run(this.pink[0].next());
      this.whoosh[1].run(this.pink[1].next());
      const wa = this.whoosh[0].bp * g[0], wb = this.whoosh[1].bp * g[1];
      const rum = this.rumble.lp(this.brown.next()) * g[2];
      this.howl[0].run(white());
      this.howl[1].run(white());
      const h1 = this.howl[0].bp * g[3], h2 = this.howl[1].bp * g[4];
      this.whistle.run(white());
      const wh = this.whistle.bp * g[5];
      let ll = 0, lr = 0;
      for (let c = 0; c < 2; c++) {
        const imp = rnd() < this.pLeaves ? white() * rnd() ** 3 : 0;
        this.leaves[c].run(imp);
      }
      ll = this.leaves[0].bp * 0.5;
      lr = this.leaves[1].bp * 0.5;
      const l = wa * 0.9 + wb * 0.4 + rum + h1 * 0.8 + h2 * 0.5 + wh * 0.4 + ll;
      const r = wa * 0.4 + wb * 0.9 + rum + h1 * 0.5 + h2 * 0.8 + wh * 0.7 + lr;
      L[i] += l;
      R[i] += r;
      WL[i] += (h1 + h2 + wh) * 0.25 + l * 0.04;
      WR[i] += (h1 + h2 + wh) * 0.25 + r * 0.04;
    }
  }
}

class Storm extends Gen {
  constructor() {
    super();
    this.rain = new Rain({ heavy: true });
    this.wind = new Wind({ strength: 1.5 });
    this.thunder = new Thunder({ close: true, gap: [8, 28] });
  }
  render(L, R, WL, WR, n) {
    // sheets of rain come with the gusts
    this.rain.boost = 0.75 + 0.6 * this.wind.speed;
    this.mix(this.wind, 0.7, L, R, WL, WR, n);
    this.mix(this.rain, 1, L, R, WL, WR, n);
    this.mix(this.thunder, 1.1, L, R, WL, WR, n);
  }
}

/* ---------- ocean ---------- */

// Waves arrive in sets with lulls in between. Each wave swells, breaks (the break
// travels along the shore), washes up as fizzing foam and drains back.
class Ocean extends Gen {
  constructor() {
    super();
    this.surf = [new Brown(), new Brown()];
    this.surfLP = [new OnePole(380), new OnePole(380)];
    this.surfAmt = new Wander(3, 9, 0.45, 1);
    this.air = [new Pink(), new Pink()];
    this.airLP = [new OnePole(1500), new OnePole(1500)];
    this.airAmt = new Wander(2, 6, 0.3, 1);
    this.swash = new Pool(Swash, 32);
    this.grains = new Pool(Ping, 160);
    this.wait = samples(0.3);
    this.setLeft = 0;
  }
  render(L, R, WL, WR, n) {
    this.wait -= n;
    if (this.wait <= 0) this.nextWave(Math.max(0, this.wait + n));
    const s = this.surfAmt.next(n) * 0.35, a = this.airAmt.next(n) * 0.05;
    for (let i = 0; i < n; i++) {
      const l = this.surfLP[0].lp(this.surf[0].next()) * s + this.airLP[0].lp(this.air[0].next()) * a;
      const r = this.surfLP[1].lp(this.surf[1].next()) * s + this.airLP[1].lp(this.air[1].next()) * a;
      L[i] += l;
      R[i] += r;
    }
    this.swash.render(L, R, WL, WR, n);
    this.grains.render(L, R, WL, WR, n);
  }
  nextWave(o) {
    if (this.setLeft <= 0) {
      this.setSize = irange(3, 7);
      this.setLeft = this.setSize;
      this.setPeak = range(0.7, 1);
    }
    const k = this.setSize - this.setLeft--;
    const h = this.setPeak * (0.45 + 0.55 * Math.sin((Math.PI * (k + 0.5)) / this.setSize)) * range(0.8, 1.05);
    this.wave(o, h);
    let gap = range(6.5, 11) * (0.85 + 0.3 * h);
    if (this.setLeft === 0) gap += range(4, 14); // lull between sets
    this.wait = o + samples(gap);
  }
  wave(o, h) {
    const p0 = range(-0.7, 0.7), p1 = clamp(p0 + range(-0.8, 0.8), -0.9, 0.9);
    const tb = range(1.8, 3);
    const sw = (opts) => this.swash.spawn()?.init(opts);
    // the swell rising before it breaks
    sw({ at: o, dur: tb + 1.2, attack: tb, tau: 0.6, amp: 0.3 * h, color: 'brown', type: 'lp', f0: 120, f1: 420, pan0: p0, wet: 0.1 });
    const ob = o + samples(tb);
    // the break, travelling along the beach
    const crashTau = range(0.8, 1.5) * (0.7 + 0.5 * h);
    sw({ at: ob, dur: 0.6 + 5 * crashTau, attack: range(0.15, 0.45) * (1.6 - 0.6 * h), tau: crashTau, amp: 0.75 * h, color: 'pink', type: 'lp', f0: 350, f1: 1500 + 3500 * h, q: 0.6, pan0: p0, pan1: p1, wet: 0.15 });
    if (h > 0.6) sw({ at: ob, dur: 1.2, attack: 0.03, tau: 0.25, amp: 0.9 * h * h, color: 'brown', type: 'lp', f0: 60, f1: 180, pan0: p0, wet: 0.1 });
    // foam washing up the beach: a hiss full of popping bubbles
    const foamTau = range(1.8, 3);
    sw({ at: ob + samples(0.15), dur: 1.2 + 4.5 * foamTau, attack: range(0.6, 1.2), tau: foamTau, amp: 0.25 * h, color: 'white', type: 'bp', f0: 2500, f1: 4500, q: 0.5, pan0: p1 * 0.7, pan1: p1 * 0.4, wet: 0.1, fizz: 1400 * h, grains: this.grains });
    // backwash draining back
    const backTau = range(1, 1.8);
    sw({ at: ob + samples(range(2.5, 4)), dur: 1.5 + 4.5 * backTau, attack: range(0.8, 1.5), tau: backTau, amp: 0.2 * h, color: 'pink', type: 'bp', f0: 450, f1: 1100, q: 0.7, pan0: p1 * 0.4, pan1: p0 * 0.3, wet: 0.12, fizz: 300 * h, grains: this.grains });
  }
}

/* ---------- river ---------- */

// A stream: several riffles, each a source of air bubbles (van den Doel) whose rate
// surges at random, so the water gurgles in bursts, over a bed of flowing noise.
class River extends Gen {
  constructor(variant) {
    super();
    const full = variant === 'Flowing';
    this.sources = [-0.75, -0.25, 0.3, 0.8].map((p) => ({
      pan: p + range(-0.1, 0.1),
      burst: new Wander(0.06, 0.5, 0, 1),
      fmin: range(240, 380),
      fmax: range(1500, 2400),
      wet: range(0.08, 0.2),
      clock: new Clock(full ? range(400, 650) : range(150, 280)),
    }));
    // both variants come out about equally loud; babbling is mostly bubbles
    this.flowAmt = full ? 0.55 : 0.16;
    this.lowAmt = full ? 0.5 : 0.14;
    this.bubbleAmp = full ? 0.14 : 0.3;
    this.pink = [new Pink(), new Pink()];
    this.flow = [new SVF(700, 0.5), new SVF(700, 0.5)];
    this.flowMod = new Wander(0.5, 3, 0.6, 1);
    this.brown = [new Brown(), new Brown()];
    this.brownLP = [new OnePole(300), new OnePole(300)];
    this.bubbles = new Pool(Ping, 256);
  }
  render(L, R, WL, WR, n) {
    const fa = this.flowMod.next(n) * this.flowAmt, la = this.lowAmt;
    for (let i = 0; i < n; i++) {
      this.flow[0].run(this.pink[0].next());
      this.flow[1].run(this.pink[1].next());
      const l = this.flow[0].bp * fa + this.brownLP[0].lp(this.brown[0].next()) * la;
      const r = this.flow[1].bp * fa + this.brownLP[1].lp(this.brown[1].next()) * la;
      L[i] += l;
      R[i] += r;
      WL[i] += l * 0.05;
      WR[i] += r * 0.05;
    }
    for (const s of this.sources) {
      const b = s.burst.next(n), accept = 0.06 + 0.94 * b * b;
      s.clock.run(n, (o) => {
        if (!chance(accept)) return;
        if (chance(0.012)) {
          bubble(this.bubbles, o, range(160, 340), this.bubbleAmp * range(1.5, 3), s.pan, s.wet, 0.18); // a deep gloop
          return;
        }
        // mostly mid-sized bubbles (the audible 'blups'), fewer tiny ones
        const f0 = s.fmin * (s.fmax / s.fmin) ** (rnd() ** 1.6);
        bubble(this.bubbles, o, f0, this.bubbleAmp * (s.fmin / f0) ** 0.3 * range(0.3, 1), s.pan + range(-0.15, 0.15), s.wet, range(0.06, 0.16));
      });
    }
    this.bubbles.render(L, R, WL, WR, n);
  }
}

class Waterfall extends Gen {
  constructor() {
    super();
    this.pink = [new Pink(), new Pink()];
    this.pinkLP = [new SVF(2600, 0.6), new SVF(2600, 0.6)];
    this.spray = [new SVF(4000, 0.5), new SVF(4000, 0.5)];
    this.brown = [new Brown(), new Brown()];
    this.brownLP = [new OnePole(150), new OnePole(150)];
    this.mods = [new Wander(1, 5, 0.75, 1), new Wander(0.3, 1.5, 0.85, 1), new Wander(2, 8, 0.7, 1)];
    this.bubbles = new Pool(Ping, 256);
    this.splashes = new Pool(Burst, 16);
    this.clock = new Clock(1500);
    this.splashClock = new Clock(5);
  }
  render(L, R, WL, WR, n) {
    const a = this.mods[0].next(n) * 0.75, b = this.mods[1].next(n) * 0.12, c = this.mods[2].next(n) * 0.9;
    for (let i = 0; i < n; i++) {
      this.pinkLP[0].run(this.pink[0].next());
      this.pinkLP[1].run(this.pink[1].next());
      this.spray[0].run(white());
      this.spray[1].run(white());
      const l = this.pinkLP[0].lp * a + this.spray[0].bp * b + this.brownLP[0].lp(this.brown[0].next()) * c;
      const r = this.pinkLP[1].lp * a + this.spray[1].bp * b + this.brownLP[1].lp(this.brown[1].next()) * c;
      L[i] += l;
      R[i] += r;
      WL[i] += l * 0.12;
      WR[i] += r * 0.12;
    }
    this.clock.run(n, (o) => bubble(this.bubbles, o, logRange(400, 4000), range(0.015, 0.07), range(-1, 1), 0.15));
    this.splashClock.run(n, (o) => this.splashes.spawn()?.init(o, range(800, 3000), 0.8, range(0.02, 0.08), range(0.05, 0.15), range(-0.8, 0.8), 0.2));
    this.bubbles.render(L, R, WL, WR, n);
    this.splashes.render(L, R, WL, WR, n);
  }
}

/* ---------- cave drips ---------- */

// A few fixed drip points, each with its own slowly drifting rhythm and its own
// pool (pitch), mostly heard through the cave's reverb.
class Drips extends Gen {
  constructor() {
    super();
    this.sources = Array.from({ length: 5 }, () => ({
      period: logRange(0.8, 5),
      drift: new Wander(10, 40, -0.15, 0.15),
      f0: range(650, 2000),
      rise: range(0.3, 0.9),
      tau: range(0.008, 0.025),
      amp: range(0.35, 1),
      pan: range(-0.85, 0.85),
      wet: range(0.55, 0.95),
      pool: chance(0.85),
      wait: samples(range(0.1, 3)),
    }));
    this.pings = new Pool(Ping, 32);
    this.ticks = new Pool(Burst, 16);
    this.stray = new Clock(0.25);
    this.air = [new Brown(), new Brown()];
    this.airLP = [new OnePole(90), new OnePole(90)];
  }
  render(L, R, WL, WR, n) {
    for (let i = 0; i < n; i++) {
      L[i] += this.airLP[0].lp(this.air[0].next()) * 0.04;
      R[i] += this.airLP[1].lp(this.air[1].next()) * 0.04;
    }
    for (const s of this.sources) {
      const drift = s.drift.next(n);
      while (s.wait < n) {
        this.drop(s.wait, s);
        s.wait += samples(s.period * (1 + drift) * range(0.95, 1.05) + (chance(0.03) ? range(3, 12) : 0));
      }
      s.wait -= n;
    }
    this.stray.run(n, (o) => this.drop(o, { f0: range(500, 2200), rise: range(0.3, 0.9), tau: range(0.006, 0.02), amp: range(0.1, 0.35), pan: range(-1, 1), wet: 0.95, pool: chance(0.7) }));
    this.ticks.render(L, R, WL, WR, n);
    this.pings.render(L, R, WL, WR, n);
  }
  drop(o, s) {
    this.ticks.spawn()?.init(o, range(2500, 5000), 1.2, range(0.0003, 0.0008), 0.12 * s.amp, s.pan, s.wet);
    if (!s.pool) return;
    const f0 = s.f0 * range(0.97, 1.03), d = 1 / s.tau;
    this.pings.spawn()?.init(o + samples(0.001), f0, d, s.rise / (3 * s.tau), 0.5 * s.amp * range(0.8, 1), s.pan, s.wet);
    if (chance(0.3)) {
      // a smaller droplet thrown up by the splash falls back
      this.pings.spawn()?.init(o + samples(range(0.06, 0.15)), f0 * range(1.2, 1.6), d * 1.3, s.rise / (3 * s.tau), 0.15 * s.amp, s.pan + range(-0.1, 0.1), s.wet);
    }
  }
}

/* ---------- crickets ---------- */

// Field crickets chirp 3–5 tonal syllables (~4.5 kHz); a few tree crickets trill
// lower. Each insect keeps its own drifting tempo, sometimes pauses, and sounds
// duller and more reverberant the further away it is.
class Crickets extends Gen {
  constructor() {
    super();
    this.bugs = Array.from({ length: 12 }, (_, i) => {
      const dist = i < 3 ? range(0.05, 0.3) : range(0.35, 1), tree = i >= 9;
      const b = {
        tree,
        w: (TAU * (tree ? range(2700, 3300) : range(4300, 5000))) / SR,
        syl: tree ? 0 : irange(3, 5),
        sylDur: range(0.012, 0.019),
        gap: range(0.012, 0.02),
        period: range(0.33, 0.8),
        drift: new Wander(8, 30, -0.08, 0.08),
        amp: (tree ? 0.5 : 1) * (0.3 - 0.24 * dist),
        lp: new SVF(9500 - 6000 * dist, 0.7),
        ph: 0,
        pos: -1,
        len: 1,
        a: 0,
        left: 0,
        wait: samples(range(0, 1.5)),
      };
      setPan(b, range(-0.9, 0.9), 0.12 + 0.55 * dist);
      return b;
    });
    this.shimmer = [new SVF(4600, 6), new SVF(4600, 6)];
    this.shimmerAmt = new Wander(0.03, 0.12, 0, 1);
    this.night = [new Pink(), new Pink()];
    this.nightLP = [new OnePole(500), new OnePole(500)];
  }
  render(L, R, WL, WR, n) {
    for (const b of this.bugs) this.bug(b, L, R, WL, WR, n);
    for (let i = 0; i < n; i++) {
      const m = this.shimmerAmt.next() ** 2 * 0.012;
      this.shimmer[0].run(white());
      this.shimmer[1].run(white());
      const l = this.shimmer[0].bp * m + this.nightLP[0].lp(this.night[0].next()) * 0.01;
      const r = this.shimmer[1].bp * m + this.nightLP[1].lp(this.night[1].next()) * 0.01;
      L[i] += l;
      R[i] += r;
      WL[i] += l * 0.3;
      WR[i] += r * 0.3;
    }
  }
  bug(b, L, R, WL, WR, n) {
    const drift = b.drift.next(n);
    for (let i = 0; i < n; i++) {
      if (b.pos >= 0) {
        const x = b.pos / b.len;
        const env = x < 0.2 ? smooth(x / 0.2) : x > 0.6 ? smooth((1 - x) / 0.4) : 1;
        b.ph += b.w * (1 - 0.05 * x);
        let s = Math.sin(b.ph);
        s = (s + 0.08 * (1 - 2 * s * s) + 0.03 * (3 * s - 4 * s * s * s)) * env * b.a;
        s = b.lp.run(s);
        L[i] += s * b.gl;
        R[i] += s * b.gr;
        WL[i] += s * b.wl;
        WR[i] += s * b.wr;
        if (++b.pos >= b.len) {
          b.pos = -1;
          if (b.left > 0) b.wait = samples(b.gap * range(0.9, 1.1));
          else if (b.tree) b.wait = samples(range(0.4, 3));
          else b.wait = samples(Math.max(0.1, b.period * (1 + drift) * range(0.96, 1.04) - b.syl * (b.sylDur + b.gap)) + (chance(0.02) ? range(2, 10) : 0));
        }
      } else if (--b.wait <= 0) {
        if (b.left <= 0) b.left = b.tree ? irange(60, 250) : b.syl - (chance(0.08) ? 1 : 0);
        const first = b.tree ? false : b.left === b.syl;
        b.left--;
        b.pos = 0;
        b.len = samples(b.sylDur * range(0.95, 1.05));
        b.a = b.amp * range(0.85, 1) * (first ? 0.7 : 1);
      }
    }
  }
}

/* ---------- birds ---------- */

// Song archetypes. A note is [start, duration, f0, f1, bend, vibrato rate, vibrato depth, amp, 2nd harmonic].
const SONGS = {
  blackbird() {
    const notes = [];
    let t = 0;
    for (let i = irange(3, 6); i > 0; i--) {
      const d = range(0.08, 0.25), f0 = range(1400, 2600);
      notes.push([t, d, f0, f0 * range(0.8, 1.3), range(-250, 450), chance(0.35) ? range(22, 40) : 0, range(30, 90), range(0.6, 1), 0.12]);
      t += d + range(0.03, 0.09);
    }
    for (let i = irange(2, 6); i > 0; i--) {
      const d = range(0.02, 0.05), f0 = range(3500, 6500);
      notes.push([t, d, f0, f0 * range(0.65, 1.25), 0, 0, 0, range(0.25, 0.45), 0.05]);
      t += d + range(0.015, 0.04);
    }
    return notes;
  },
  robin() {
    const notes = [];
    let t = 0;
    for (let i = irange(5, 10); i > 0; i--) {
      if (chance(0.25)) {
        const f = range(3500, 6500);
        for (let k = irange(3, 6); k > 0; k--) {
          notes.push([t, 0.025, f, f * 0.85, 0, 0, 0, 0.5, 0.05]);
          t += 0.04;
        }
      } else {
        const d = range(0.05, 0.2), f0 = range(2500, 7500);
        notes.push([t, d, f0, f0 * range(0.6, 1.5), range(-800, 800), 0, 0, range(0.4, 1), 0.05]);
        t += d;
      }
      t += range(0.02, 0.08);
    }
    return notes;
  },
  chaffinch() {
    const notes = [];
    let t = 0, f = range(5200, 6200);
    const a = irange(4, 6), b = irange(3, 5);
    for (let i = 0; i < a; i++) {
      notes.push([t, 0.07, f, f * 0.82, 0, 0, 0, 0.7 + (0.3 * i) / a, 0.05]);
      t += 0.11 - i * 0.006;
      f *= 0.97;
    }
    f = range(3800, 4400);
    for (let i = 0; i < b; i++) {
      notes.push([t, 0.045, f, f * 0.9, 0, 0, 0, 0.9, 0.05]);
      t += 0.07;
      f *= 0.96;
    }
    notes.push([t + 0.03, 0.28, 3000, 2300, 2400, 0, 0, 1, 0.08]);
    return notes;
  },
  tit() {
    const notes = [], hi = range(5200, 6800), lo = hi * range(0.55, 0.68);
    let t = 0;
    for (let r = irange(3, 6); r > 0; r--) {
      notes.push([t, 0.07, hi, hi * 0.96, 0, 0, 0, 0.9, 0.03]);
      t += 0.1;
      notes.push([t, 0.09, lo, lo * 0.95, 0, 0, 0, 0.8, 0.05]);
      t += 0.13;
    }
    return notes;
  },
  dove() {
    const notes = [], f = range(430, 520);
    let t = 0;
    for (const d of chance(0.5) ? [0.35, 0.55, 0.3, 0, 0.3, 0.3] : [0.4, 0.4, 0.6, 0, 0.35]) {
      if (!d) {
        t += 0.35;
        continue;
      }
      notes.push([t, d, f * range(0.95, 1), f * range(0.9, 0.97), f * 0.08, 0, 0, 0.9, 0.3]);
      t += d + 0.12;
    }
    return notes;
  },
  warbler() {
    const notes = [];
    let t = 0, f = range(5000, 6200);
    for (let i = irange(9, 15); i > 0; i--) {
      notes.push([t, range(0.05, 0.08), f, f * range(0.8, 0.92), range(-200, 300), 0, 0, range(0.6, 1), 0.05]);
      t += range(0.07, 0.1);
      f *= range(0.95, 0.985);
    }
    return notes;
  },
};

const PAUSES = { blackbird: [4, 9], robin: [3, 7], chaffinch: [6, 12], tit: [4, 10], dove: [12, 35], warbler: [5, 10] };

class Birds extends Gen {
  constructor() {
    super();
    const kinds = Object.keys(SONGS).sort(() => rnd() - 0.5).slice(0, 5);
    this.birds = kinds.map((kind) => {
      const dist = range(0.1, 1);
      const b = {
        kind,
        songs: [SONGS[kind](), SONGS[kind](), SONGS[kind]()],
        gain: 0.2 * (1 - 0.6 * dist),
        lp: new SVF(10000 - 6000 * dist, 0.7),
        wait: samples(range(0.3, 5)),
        notes: null,
        ni: 0,
        t: 0,
        ph: 0,
        vph: 0,
        pitch: 1,
      };
      setPan(b, range(-0.9, 0.9), 0.15 + 0.4 * dist);
      return b;
    });
    this.bed = [new Pink(), new Pink()];
    this.bedLP = [new OnePole(700), new OnePole(700)];
  }
  render(L, R, WL, WR, n) {
    for (let i = 0; i < n; i++) {
      L[i] += this.bedLP[0].lp(this.bed[0].next()) * 0.012;
      R[i] += this.bedLP[1].lp(this.bed[1].next()) * 0.012;
    }
    for (const b of this.birds) {
      if (!b.notes) {
        b.wait -= n;
        if (b.wait > 0) continue;
        b.notes = pick(b.songs);
        b.ni = 0;
        b.t = Math.max(0, b.wait + n);
        b.t = -b.t;
        b.pitch = range(0.97, 1.03);
        b.tempo = range(0.94, 1.06);
      }
      this.sing(b, L, R, WL, WR, n);
    }
  }
  sing(b, L, R, WL, WR, n) {
    const notes = b.notes;
    for (let i = 0; i < n; i++, b.t++) {
      if (b.ni >= notes.length) {
        const [lo, hi] = PAUSES[b.kind];
        b.notes = null;
        b.wait = samples(range(lo, hi) + (chance(0.2) ? range(10, 30) : 0));
        return;
      }
      const [st, d, f0, f1, bend, vib, vibD, amp, h2] = notes[b.ni];
      const ns = st * b.tempo * SR, len = d * b.tempo * SR;
      if (b.t < ns) continue;
      const x = (b.t - ns) / len;
      if (x >= 1) {
        b.ni++;
        continue;
      }
      let f = (f0 + (f1 - f0) * x + bend * 4 * x * (1 - x)) * b.pitch;
      if (vib) {
        f += vibD * Math.sin(b.vph);
        b.vph += (TAU * vib) / SR;
      }
      b.ph += (TAU * f) / SR;
      const env = x < 0.12 ? smooth(x / 0.12) : x > 0.75 ? smooth((1 - x) / 0.25) : 1;
      let s = Math.sin(b.ph);
      s = b.lp.run((s + h2 * (1 - 2 * s * s)) * env * amp * b.gain);
      L[i] += s * b.gl;
      R[i] += s * b.gr;
      WL[i] += s * b.wl;
      WR[i] += s * b.wr;
    }
  }
}

/* ---------- wind chimes ---------- */

const CHIME_SCALES = {
  Pentatonic: [523.25, 587.33, 659.26, 783.99, 880.0, 1046.5],
  Minor: [440.0, 523.25, 587.33, 659.26, 783.99, 880.0],
  Deep: [220.0, 261.63, 293.66, 329.63, 392.0, 440.0],
  High: [1318.51, 1567.98, 1760.0, 1975.53, 2349.32, 2637.02],
};

// Modal synthesis: each tube is a set of resonators at the free-free bar ratios,
// set ringing by a short clapper contact. A breeze drives how often the clapper
// swings; tubes slowly turn, so their loudness shimmers.
class Chimes extends Gen {
  constructor(variant) {
    super();
    const scale = CHIME_SCALES[variant] ?? CHIME_SCALES.Pentatonic;
    this.tubes = scale.map((f, i) => {
      const T = clamp(9 * Math.sqrt(440 / f), 2.5, 14), modes = [];
      for (const [r, a] of [[1, 1], [2.756, 0.55], [5.404, 0.3], [8.933, 0.15], [13.34, 0.06]]) {
        if (f * r < SR * 0.45) modes.push(new Mode(f * r, T / r ** 0.8, a));
      }
      modes.push(new Mode(f + range(0.3, 0.9), T, 0.5));
      const t = { modes, contact: 0, clen: 1, camp: 0, startAt: -1, quiet: true, swing: new Wander(0.5, 1.5, 0.8, 1.15) };
      setPan(t, -0.6 + (1.2 * i) / (scale.length - 1), 0.35);
      return t;
    });
    this.idx = irange(0, scale.length - 1);
    this.breeze = new Wander(6, 20, 0.05, 0.6);
    this.gusts = new Gusts(10, [0.5, 1.5], [1.5, 4], [0.1, 0.4]);
    this.clock = new Clock(4);
  }
  hit(tube, o, vel) {
    tube.startAt = o;
    tube.clen = samples(range(0.0003, 0.0008));
    tube.camp = vel * 0.004;
    tube.quiet = false;
  }
  render(L, R, WL, WR, n) {
    this.runQueue(n);
    const wind = clamp(this.breeze.next(n) + this.gusts.next(n), 0, 1);
    this.clock.run(n, (o) => {
      if (!chance(0.03 + wind * wind)) return;
      const nt = this.tubes.length;
      this.idx = chance(0.3) ? irange(0, nt - 1) : clamp(this.idx + pick([-2, -1, 1, 2]), 0, nt - 1);
      const tube = this.tubes[this.idx], vel = range(0.3, 1) * (0.5 + wind);
      this.hit(tube, o, vel);
      if (chance(0.35)) this.after(o + samples(range(0.04, 0.12)), (oo) => this.hit(tube, oo, vel * 0.35));
    });
    for (const t of this.tubes) {
      if (t.quiet) continue;
      const g = t.swing.next(n);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        if (i === t.startAt) {
          t.contact = t.clen;
          t.startAt = -1;
        }
        let x = 0;
        if (t.contact > 0) x = t.camp * Math.sin((Math.PI * (t.clen - t.contact--)) / t.clen);
        let y = 0;
        for (let k = 0; k < t.modes.length; k++) y += t.modes[k].tick(x);
        y *= g;
        L[i] += y * t.gl;
        R[i] += y * t.gr;
        WL[i] += y * t.wl;
        WR[i] += y * t.wr;
        const ay = y < 0 ? -y : y;
        if (ay > peak) peak = ay;
      }
      if (t.startAt >= 0) t.startAt -= n;
      if (peak < 1e-6 && t.contact <= 0 && t.startAt < 0) {
        t.quiet = true;
        for (const m of t.modes) m.y1 = m.y2 = 0;
      }
    }
  }
}

/* ---------- singing bowl ---------- */

// Two bowls as pairs of slightly detuned modes (the slow beating "wah"). Mostly
// struck with a felt mallet; sometimes rimmed, which makes the bowl sing and swell.
class Bowl extends Gen {
  constructor() {
    super();
    const base = [146.83, 174.61, 196.0, 220.0, 261.63], i = irange(0, base.length - 2);
    this.bowls = [base[i], base[i + 1]].map((f0) => {
      const T = range(25, 35), modes = [];
      [[1, 1], [2.71, 0.6], [5.15, 0.35], [8.2, 0.15], [11.9, 0.07]].forEach(([r, a], k) => {
        const f = f0 * r, beat = range(0.4, 1.4) * (1 + k * 0.6);
        if (f > SR * 0.45) return;
        modes.push(new Mode(f - beat / 2, T / r ** 0.85, a), new Mode(f + beat / 2, T / r ** 0.85, a));
      });
      const b = { f0, modes, contact: 0, clen: 1, camp: 0, startAt: -1, rim: 0, rimLen: 1, rimF: new SVF(f0, 30), quiet: true };
      setPan(b, range(-0.35, 0.35), 0.35);
      return b;
    });
    this.wait = samples(0.3);
  }
  render(L, R, WL, WR, n) {
    this.wait -= n;
    if (this.wait <= 0) {
      const b = pick(this.bowls), o = Math.max(0, this.wait + n);
      if (chance(0.25)) {
        b.rim = 1;
        b.rimLen = samples(range(14, 24));
        this.wait = b.rimLen + samples(range(8, 16));
      } else {
        b.startAt = o;
        b.clen = samples(range(0.003, 0.005));
        b.camp = range(0.6, 1) * 0.0012;
        this.wait = samples(range(16, 40));
      }
      b.quiet = false;
    }
    for (const b of this.bowls) {
      if (b.quiet) continue;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        if (i === b.startAt) {
          b.contact = b.clen;
          b.startAt = -1;
        }
        let x = 0;
        if (b.contact > 0) x = b.camp * Math.sin((Math.PI * (b.clen - b.contact--)) / b.clen);
        let rimX = 0;
        if (b.rim > 0) {
          const p = b.rim / b.rimLen, e = p < 0.6 ? smooth(p / 0.6) : smooth((1 - p) / 0.4);
          b.rimF.run(white());
          rimX = b.rimF.bp * e * 0.0006;
          if (++b.rim >= b.rimLen) b.rim = 0;
        }
        let y = 0;
        for (let k = 0; k < b.modes.length; k++) y += b.modes[k].tick(k < 4 ? x + rimX : x);
        L[i] += y * b.gl;
        R[i] += y * b.gr;
        WL[i] += y * b.wl;
        WR[i] += y * b.wr;
        const ay = y < 0 ? -y : y;
        if (ay > peak) peak = ay;
      }
      if (b.startAt >= 0) b.startAt -= n;
      if (peak < 1e-6 && b.contact <= 0 && b.rim === 0 && b.startAt < 0) {
        b.quiet = true;
        for (const m of b.modes) m.y1 = m.y2 = 0;
      }
    }
  }
}

/* ---------- drone ---------- */

function polyBlep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// A choir-like "om": detuned voices drifting in pitch, sung through slowly
// changing vowel formants, with a breathing swell.
class Drone extends Gen {
  constructor() {
    super();
    const f = 98;
    this.voices = [[1, 0, 0.5, -0.4], [1, 6, 0.45, 0.4], [1, -7, 0.45, 0], [2, 3, 0.22, 0.3], [1.5, -2, 0.15, -0.3]].map(([m, c, a, p]) => {
      const v = { f: f * m * 2 ** (c / 1200), a, ph: rnd(), dt: 0, drift: new Wander(4, 10, -4, 4) };
      setPan(v, p, 0);
      return v;
    });
    this.formants = [0, 1].map(() => [new SVF(420, 6), new SVF(820, 8), new SVF(2600, 12)]);
    this.f1 = new Wander(5, 12, 380, 480);
    this.f2 = new Wander(5, 12, 750, 900);
    this.dry = [new OnePole(300), new OnePole(300)];
    this.breath = new Wander(5, 10, 0.72, 1);
    this.breathNoise = new Pink();
    this.sub = 0;
    this.subF = f / 2;
  }
  render(L, R, WL, WR, n) {
    for (const v of this.voices) v.dt = (v.f * 2 ** (v.drift.next(n) / 1200)) / SR;
    const f1 = this.f1.next(n), f2 = this.f2.next(n), amp = this.breath.next(n);
    for (const fs of this.formants) {
      fs[0].set(f1, 6);
      fs[1].set(f2, 8);
    }
    for (let i = 0; i < n; i++) {
      let l = 0, r = 0;
      for (const v of this.voices) {
        v.ph += v.dt;
        if (v.ph >= 1) v.ph -= 1;
        const s = (2 * v.ph - 1 - polyBlep(v.ph, v.dt)) * v.a;
        l += s * v.gl;
        r += s * v.gr;
      }
      const nz = this.breathNoise.next() * 0.04;
      this.sub += (TAU * this.subF) / SR;
      const sub = Math.sin(this.sub) * 0.3;
      const ol = (this.vowel(0, l + nz) + sub) * amp, or = (this.vowel(1, r + nz) + sub) * amp;
      L[i] += ol;
      R[i] += or;
      WL[i] += ol * 0.4;
      WR[i] += or * 0.4;
    }
  }
  vowel(c, x) {
    const f = this.formants[c];
    f[0].run(x);
    f[1].run(x);
    f[2].run(x);
    return f[0].bp + f[1].bp * 0.5 + f[2].bp * 0.15 + this.dry[c].lp(x) * 0.25;
  }
}

/* ---------- binaural beats ---------- */

const BEATS = { 'Theta 6 Hz': 6, 'Alpha 10 Hz': 10, 'Delta 3 Hz': 3 };

class Binaural extends Gen {
  constructor(variant) {
    super();
    const beat = BEATS[variant] ?? 6;
    this.wl = (TAU * (200 - beat / 2)) / SR;
    this.wr = (TAU * (200 + beat / 2)) / SR;
    this.pl = this.pr = 0;
  }
  render(L, R, WL, WR, n) {
    for (let i = 0; i < n; i++) {
      L[i] += Math.sin((this.pl += this.wl)) * 0.25;
      R[i] += Math.sin((this.pr += this.wr)) * 0.25;
    }
    this.pl %= TAU;
    this.pr %= TAU;
  }
}

/* ------------------------------------------------------------------ */
/* Processor                                                           */
/* ------------------------------------------------------------------ */

const GENERATORS = {
  rain: () => new Rain(),
  thunder: () => new Thunder(),
  storm: () => new Storm(),
  wind: () => new Wind(),
  ocean: () => new Ocean(),
  river: (v) => new River(v),
  waterfall: () => new Waterfall(),
  drops: () => new Drips(),
  fire: () => new Fire(),
  birds: () => new Birds(),
  crickets: () => new Crickets(),
  chimes: (v) => new Chimes(v),
  bowl: () => new Bowl(),
  drone: () => new Drone(),
  binaural: (v) => new Binaural(v),
  white: () => new WhiteNoise(),
  pink: () => new PinkNoise(),
  brown: () => new BrownNoise(),
};

class SynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { kind, variant } = options.processorOptions;
    this.gen = GENERATORS[kind](variant);
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.alive = false;
    };
  }
  process(inputs, outputs) {
    const [dry, wet] = outputs;
    const L = dry[0], R = dry[1] ?? dry[0], WL = wet[0], WR = wet[1] ?? wet[0];
    L.fill(0);
    R.fill(0);
    WL.fill(0);
    WR.fill(0);
    this.gen.render(L, R, WL, WR, L.length);
    return this.alive;
  }
}

registerProcessor('synth', SynthProcessor);
