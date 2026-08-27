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
- [ ] Add saved experiment configurations and comparable benchmark results.

## Live receiver

- [x] Add configured FSK raw-symbol detection and a symbol-likelihood waterfall.
- [ ] Add robust preambles and physical-layer packet headers. *(Current)*
- [ ] Detect packet timing in the continuous microphone stream for the selected mode.
- [ ] Estimate frequency/sample-clock offset and collect complete packets.
- [ ] Decode live packets, verify CRC, and display acquisition/rejection metrics.
- [ ] Add automatic multi-mode detection.
- [ ] Add overlapping-user detection and successive decoding experiments.

Live decoding requires acquisition and synchronization before the existing block decoders can process arbitrary microphone samples. Implement selected-mode acquisition first; add automatic mode classification only after each detector works independently.

## Messaging

- [ ] Define authenticated packet identities, sequencing, ACKs, and retry behavior.
- [ ] Add pairing and authenticated encryption.
- [ ] Build nearby text messaging on the validated acoustic profiles.
- [ ] Evaluate native mobile development only if background reception or audio routing becomes essential.
