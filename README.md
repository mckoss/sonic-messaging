# Sonic Messaging

Sonic Messaging is a local-first PWA for nearby data-over-sound communication on desktop and mobile browsers. Its initial modulation and protocol test bed will become the foundation for messaging.

Current experiments include:

- M-ary FSK with configurable lowest tone, arithmetic tone spacing, tone count, and symbol rate
- LoRa-like cyclic chirp spread spectrum (CSS) with configurable spreading factor
- DSSS using Gold, small-set Kasami, and m-sequence codes
- Competing-user detection and rejection metrics for DSSS
- Deterministic channel simulation with attenuation, AWGN, frequency offset, and interferers
- Live microphone waterfall processing in a Web Worker
- Audio capture and playback through AudioWorklets

## Development

```sh
nvm use
npm install
npm run dev
```

Node 24.20.0 (the current LTS release) is pinned in `.nvmrc`; npm rejects unsupported Node major versions.

Microphone access requires HTTPS or `localhost`.

## Verification

```sh
npm test
npm run check
npm run build
```

The GitHub Pages workflow runs all three checks before deployment.

Every push or merge to `main` must increase the semantic version in `package.json`. CI rejects a deployment when the version is unchanged or moves backward; choose a patch, minor, or major increase according to the compatibility impact.

## Architecture

- `src/lib/dsp`: browser-safe modem algorithms, framing, codes, and simulated channels
- `src/workers`: spectrum analysis and modem simulation off the main thread
- `src/worklets`: real-time capture and playback processors
- `src/lib/audio`: browser audio lifecycle and typed worker/worklet contracts
- `src/lib/components`: responsive Svelte controls and spectrum visualization

The receiver acquires and decodes live FSK packets from an unaligned microphone stream, validates CRC, and displays decoded text. CSS and DSSS currently support simulation; live acquisition and phase handling remain planned.

## Record and replay FSK experiments

1. Select FSK and configure the receiver for the other device's transmitted signal.
2. Under **Record & decode**, enter device, distance, orientation, volume, and noise notes, then select **Record microphone**. Capture includes quiet intervals and failed packets and stops automatically after two minutes. **Stop recording** finishes the recording while listening continues; **Stop listening** also finishes recording.
3. **Save recording WAV** downloads mono 32-bit float audio with embedded FSK settings, original sample rate, actual microphone settings, capture timestamp, app version, browser information, and notes. Save before starting another recording or leaving the page; recordings are held in memory.
4. **Load recording WAV** accepts files saved by this app and restores their FSK settings. **Decode recording** stops live listening and feeds the original samples directly into a fresh DSP receiver without opening a microphone, playing through speakers, or resampling. It shows waterfalls, decoded text, CRC-valid packet counts, and CRC failure events. Replay targets the original pace and may run slower if decoding is expensive.
5. Change FSK controls between replays to compare receiver settings, or choose **Restore recorded FSK settings**. The recorded samples stay unchanged. Editing notes updates the metadata in the next download.

A recording compares receivers against one captured waveform; testing a different transmitted modulation or encoding requires another capture. CRC counts alone are not packet delivery rates because this first milestone does not yet track attempted transmissions. Automated two-device schedules, SNR measurements, batch comparisons, and physical-device regression datasets are next in `PLAN.md`.

The older **Replay visible audio** and **Replay FFT view** controls play sound through the speaker; **Decode recording** is the repeatable receiver experiment.
