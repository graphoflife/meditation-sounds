# Meditation Sounds

A minimal web app for mixing ambient sounds for meditation and sleep. Every sound is
synthesised live, sample by sample, from random processes in an AudioWorklet. There are
no audio files and no loops, so nothing ever repeats.

**Sounds:** rain, thunder, storm, wind, ocean, river, waterfall, cave drips, campfire,
birds, crickets, wind chimes (four tunings), singing bowl, drone, binaural beats
(theta / alpha / delta), and white, pink and brown noise.

## How the sounds are made

- **Campfire, wind, running water, rain:** after Andy Farnell, *Designing Sound* (MIT Press):
  random-triggered crackles, hiss gated by a random envelope, clipped low "lapping"; a
  wind-speed signal of drift, gusts and turbulence that reaches each object with its own delay.
- **River, waterfall, ocean foam, drips:** air bubbles after K. van den Doel, *Physically based
  models for liquid sounds* (2005): Minnaert pitch, physical damping and rising pitch, in bursts.
- **Rain:** drops as an impact plus, on water, a ringing bubble (Liu, Cheng & Tong, 2019),
  landing on leaves, soil, stone and puddles.
- **Thunder:** a random 3‑D lightning channel; every segment emits an N‑wave heard after
  distance / 343 s (Ribner & Roy, *Acoustics of thunder*), plus scattering and echoes.
- **Ocean:** waves in sets with lulls; each swells, breaks along the beach, washes up as fizzing
  foam and drains back.
- **Crickets, birds:** individual insects with drifting tempos; bird song archetypes (blackbird,
  robin, chaffinch, great tit, wood pigeon, willow warbler) at different distances.
- **Chimes, singing bowl:** modal synthesis (resonators at the instruments' mode ratios).

Tap a tile to turn a sound on, use its slider to set the volume, and mix as many as you
like. The sleep timer fades everything out over the last 45 seconds.

## Screen off / background playback

The page plays a near-silent looping `<audio>` element alongside Web Audio and registers
with the Media Session API. Browsers then treat it as a media player: playback continues
with the screen locked, and play/pause shows up on the lock screen. On iOS 16.4+ it also
sets `navigator.audioSession.type = 'playback'`, so it plays even with the silent switch on.
All synthesis runs on the audio thread, so throttled page timers don't affect it.

## Files

- `synth.js`: the AudioWorklet that synthesises every sound
- `audio.js`: engine: audio context, reverbs (room, cave, outdoor), mixing, sleep-timer fade
- `app.js`: UI, playback state, sleep timer, media session
- `icons.js`: line icons
- `sw.js`, `manifest.webmanifest`: offline support and "Add to Home Screen"
- `dev/analyze.html`: renders every sound offline and shows loudness (LUFS), peaks, CPU and
  spectrograms; used to balance levels and spot artefacts

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
