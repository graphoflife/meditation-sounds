// AudioWorklet processor for the signals that are defined mathematically and so are
// exactly right when generated: white, pink and brown noise, and binaural beats.
// Generating them sample by sample means they never repeat.

const SR = sampleRate;
const TAU = 2 * Math.PI;
const white = () => Math.random() * 2 - 1;
const smooth = (x) => x * x * (3 - 2 * x);

class OnePole {
  constructor(fc) {
    this.y = 0;
    this.a = 1 - Math.exp((-TAU * fc) / SR);
  }
  lp(x) {
    return (this.y += this.a * (x - this.y));
  }
  hp(x) {
    return x - this.lp(x);
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

// Shades of brown noise: the same random walk, darkened by extra low-pass filtering or
// lightened with some pink noise. Gains keep every shade about equally loud (LUFS).
const BROWN = {
  Classic: { gain: 1 },
  Deep: { lp: 180, gain: 1.93 },
  Smooth: { lp: 650, gain: 1.35 },
  Light: { pink: 0.5, gain: 0.7 },
  Waves: { pink: 0.2, swell: true, gain: 1.19 },
};

class Brown {
  constructor(shade) {
    this.shade = shade;
    this.l = 0;
    this.dc = new OnePole(25);
    this.lp = shade.lp ? [new OnePole(shade.lp), new OnePole(shade.lp)] : null;
    this.pink = shade.pink ? new Pink() : null;
  }
  next() {
    this.l = (this.l + 0.02 * white()) / 1.02;
    let x = this.dc.hp(this.l * 3.5);
    if (this.lp) x = this.lp[1].lp(this.lp[0].lp(x));
    if (this.pink) x += this.pink.next() * this.shade.pink;
    return x * this.shade.gain;
  }
}

// Slow swells like distant surf: each one rises over 40% of its length and ebbs over
// the rest, with random lengths (7–14 s) and heights, so they never fall into a rhythm.
class Swell {
  constructor() {
    this.t = this.len = 0;
    this.h = 0;
  }
  next() {
    if (++this.t >= this.len) {
      this.t = 0;
      this.len = Math.round((7 + Math.random() * 7) * SR);
      this.h = 0.55 + Math.random() * 0.45;
    }
    const p = this.t / this.len;
    return 0.3 + 0.7 * this.h * (p < 0.4 ? smooth(p / 0.4) : 1 - smooth((p - 0.4) / 0.6));
  }
}

const whiteSource = () => ({ next: () => white() * 0.4 });

class Noise {
  constructor(make, swell = null) {
    this.l = make();
    this.r = make();
    this.swell = swell;
  }
  render(L, R) {
    for (let i = 0; i < L.length; i++) {
      const g = this.swell ? this.swell.next() : 1;
      L[i] = this.l.next() * g;
      R[i] = this.r.next() * g;
    }
  }
}

const BEATS = { 'Theta 6 Hz': 6, 'Alpha 10 Hz': 10, 'Delta 3 Hz': 3 };

class Binaural {
  constructor(variant) {
    const beat = BEATS[variant] ?? 6;
    this.wl = (TAU * (200 - beat / 2)) / SR;
    this.wr = (TAU * (200 + beat / 2)) / SR;
    this.pl = this.pr = 0;
  }
  render(L, R) {
    for (let i = 0; i < L.length; i++) {
      L[i] = Math.sin((this.pl += this.wl)) * 0.25;
      R[i] = Math.sin((this.pr += this.wr)) * 0.25;
    }
    this.pl %= TAU;
    this.pr %= TAU;
  }
}

const GENERATORS = {
  white: () => new Noise(whiteSource),
  pink: () => new Noise(() => new Pink()),
  brown: (v) => {
    const shade = BROWN[v] ?? BROWN.Classic;
    return new Noise(() => new Brown(shade), shade.swell ? new Swell() : null);
  },
  binaural: (v) => new Binaural(v),
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
    const out = outputs[0];
    this.gen.render(out[0], out[1] ?? out[0]);
    return this.alive;
  }
}

registerProcessor('synth', SynthProcessor);
