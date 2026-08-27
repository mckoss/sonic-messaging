# Sonic Messaging development plan

## Foundation

- [x] Create the static Svelte/TypeScript PWA and GitHub Pages deployment.
- [x] Add Git, semver enforcement, Node/nvm pinning, and CI verification.
- [x] Build AudioWorklet capture/playback and Worker-isolated DSP infrastructure.
- [x] Add deterministic waveform and noisy-channel unit tests.

## Modulation test bed

- [x] Add configurable M-FSK encode/decode experiments.
- [x] Add LoRa-like cyclic CSS encode/decode experiments.
- [x] Add DSSS with Gold/Kasami experiments and competing-user metrics.
- [x] Add simulated AWGN, attenuation, frequency-offset, and interference channels.
- [x] Replace the line spectrum with a scrolling power waterfall.
- [x] Keep waterfall time and axis labels outside the signal plots for legibility.
- [x] Scroll spectrum and FSK symbol waterfalls right-to-left and show live sync/text acquisition.
- [ ] Add saved experiment configurations and comparable benchmark results.

## Live receiver

- [x] Add configured FSK raw-symbol detection and a symbol-likelihood waterfall.
- [x] Calibrate raw FSK likelihood against full-window energy so noise and partial-symbol matches are rejected.
- [ ] Add robust preambles and physical-layer packet headers. *(Current)*
- [x] Detect FSK packet timing in the continuous microphone stream using sync-word phase acquisition.
- [ ] Estimate frequency/sample-clock offset and collect complete packets.
- [x] Decode live FSK packets, verify CRC, and display valid UTF-8 payloads and confidence.
- [ ] Add automatic multi-mode detection.
- [ ] Add overlapping-user detection and successive decoding experiments.

FSK now performs sync acquisition and CRC-validated live decoding. Add equivalent acquisition for CSS and DSSS before automatic mode classification.

## Messaging

- [ ] Define authenticated packet identities, sequencing, ACKs, and retry behavior.
- [ ] Add pairing and authenticated encryption.
- [ ] Build nearby text messaging on the validated acoustic profiles.
- [ ] Evaluate native mobile development only if background reception or audio routing becomes essential.
