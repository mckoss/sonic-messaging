# Sonic Message

Sonic Message is a local-first PWA for nearby data-over-sound communication on desktop and mobile browsers. Its initial **Sonic Lab** workspace is a modulation and protocol test bed that will become the foundation for messaging.

Current experiments include:

- M-ary FSK with configurable center frequency, bandwidth, tone count, and symbol rate
- LoRa-like cyclic chirp spread spectrum (CSS) with configurable spreading factor
- DSSS using Gold, small-set Kasami, and m-sequence codes
- Competing-user detection and rejection metrics for DSSS
- Deterministic channel simulation with attenuation, AWGN, frequency offset, and interferers
- Live microphone spectrum processing in a Web Worker
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

## Architecture

- `src/lib/dsp`: browser-safe modem algorithms, framing, codes, and simulated channels
- `src/workers`: spectrum analysis and modem simulation off the main thread
- `src/worklets`: real-time capture and playback processors
- `src/lib/audio`: browser audio lifecycle and typed worker/worklet contracts
- `src/lib/components`: responsive Svelte controls and spectrum visualization

The current receiver provides live spectrum analysis. Real-time packet acquisition and decoding from an unaligned microphone stream is the next protocol-layer milestone; simulation already exercises full encode/channel/decode round trips.
