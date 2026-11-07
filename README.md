# Meditation Sounds

A minimal web app for mixing ambient sounds for meditation and sleep, built on real field
recordings released under CC0 (see [CREDITS.md](CREDITS.md)).

**Sounds:** rain, thunder, storm, wind, ocean, river, waterfall, cave drips, campfire, birds,
crickets, wind chimes, singing bowl, tanpura, binaural beats, and white, pink and brown noise
(Classic, Deep, Smooth, Light and Waves).

Tap a tile to turn a sound on, use its slider to set the volume, and mix as many as you like.
Many tiles offer several recordings: tap the small label on the tile to switch. The sleep timer
fades everything out over the last 45 seconds.

## How it plays

- **Beds** (rain, ocean, fire, …) are excerpts of 1–3 minutes. After decoding, the end of each is
  crossfaded into its start, so the loop has no seam, and playback starts at a random point.
- **Events** (thunder, singing bowl) are one-shots played at random intervals, so they never fall
  into a pattern.
- **Noise and binaural beats** are generated live in an AudioWorklet (`synth.js`), since they are
  defined mathematically.

Recordings download when first used (1–4 MB each) and are then cached for offline use.

## Screen off / background playback

The page plays a near-silent looping `<audio>` element alongside Web Audio and registers with the
Media Session API. Browsers then treat it as a media player: playback continues with the screen
locked, and play/pause shows up on the lock screen. On iOS 16.4+ it also sets
`navigator.audioSession.type = 'playback'`, so it plays even with the silent switch on. Looping
needs no page timers at all, and one-shots are booked 90 seconds ahead, so throttled timers on a
hidden page don't cause gaps.

## Files

- `audio.js`: engine and sound catalogue: loading, seamless loops, one-shots, mixing, sleep-timer fade
- `sounds/`: the recordings
- `synth.js`: AudioWorklet for noise and binaural beats
- `app.js`: UI, playback state, sleep timer, media session
- `icons.js`: line icons
- `sw.js`, `manifest.webmanifest`: offline support and "Add to Home Screen"

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
