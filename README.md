# Meditation Sounds

A minimal web app for mixing ambient sounds for meditation and sleep. Every sound is
synthesised live with the Web Audio API, with no audio files, so nothing ever loops audibly.

**Sounds:** rain, thunder, storm, wind, ocean, river, waterfall, cave drips, campfire,
birds, crickets, wind chimes (four tunings), singing bowl, drone, binaural beats
(theta / alpha / delta), and white, pink and brown noise.

Tap a tile to turn a sound on, use its slider to set the volume, and mix as many as you
like. The sleep timer fades everything out over the last 45 seconds.

## Screen off / background playback

The page plays a near-silent looping `<audio>` element alongside Web Audio and registers
with the Media Session API. Browsers then treat it as a media player: playback continues
with the screen locked, and play/pause shows up on the lock screen. On iOS 16.4+ it also
sets `navigator.audioSession.type = 'playback'`, so it plays even with the silent switch on.
Events (thunder, chimes, birds, …) are scheduled up to 12 seconds ahead while the page is
hidden, so throttled timers don't cause gaps.

## Files

- `audio.js`: the synthesis engine and all sounds
- `app.js`: UI, playback state, sleep timer, media session
- `icons.js`: line icons
- `sw.js`, `manifest.webmanifest`: offline support and "Add to Home Screen"
- `dev/analyze.html`: renders every sound offline and shows loudness (LUFS), peaks and
  spectrograms; used to balance levels and spot artefacts

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
