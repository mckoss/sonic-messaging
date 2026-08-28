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
- [ ] Add comparable benchmark results. *(Saved user configurations are complete.)*

## Live receiver

- [x] Add configured FSK raw-symbol detection and a symbol-likelihood waterfall.
- [x] Calibrate raw FSK likelihood against full-window energy so noise and partial-symbol matches are rejected.
- [x] Add a configurable dBFS squelch for live FSK symbol detection and packet acquisition.
- [x] ~~Add a configurable winning-tone confidence threshold for live FSK detection.~~ *(Removed: it gated only the display, never packet decoding, and read as a detection control; the detector's fixed calibrated floors remain.)*
- [x] Scroll quartile-colored confidence history in lockstep with live FSK symbols.
- [x] Keep live symbol visualization ahead of packet acquisition and optimize tone scoring latency.
- [x] Align spectrum, symbol-likelihood, and confidence scrolling to one captured-audio time scale.
- [x] Add bracketed, character-centered RX timing spans and a compact decoded message line.
- [x] Keep a continuous right-anchored history of CRC-valid messages in the RX bar.
- [x] Tolerate limited FSK sync errors while retaining CRC-gated payload display.
- [x] Show decoded character extents in RX-Time while keeping physical FSK symbols in likelihood rows.
- [x] Lock spectrum and symbol waterfall travel by source sequence delta, including coalesced UI updates.
- [x] Gate waterfall time-scale behavior with unit and Playwright desktop/mobile coverage.
- [x] Persist user-defined modem/channel settings locally and restore them on reload.
- [x] Stream decoded characters into RX before CRC, then mark confirmation or rejection.
- [x] Lock all receiver lanes to absolute sample positions with persisted Slow/Medium/Fast scaling.
- [x] Add a persisted microphone device picker with live capture restart.
- [ ] Add robust preambles and physical-layer packet headers. *(Current)*
- [x] Detect FSK packet timing in the continuous microphone stream using sync-word phase acquisition.
- [ ] Estimate frequency/sample-clock offset and collect complete packets.
- [x] Decode live FSK packets, verify CRC, and display valid UTF-8 payloads and confidence.
- [ ] Add forward error correction (e.g. convolutional or Reed-Solomon coding with interleaving against burst errors), so payloads survive symbol errors that currently fail the whole frame's CRC.
- [ ] Add automatic multi-mode detection.
- [ ] Add overlapping-user detection and successive decoding experiments.

- [ ] Make CSS demodulation phase-insensitive: correlate against quadrature (sine and cosine) chirp templates and score by magnitude, since the current fixed-phase correlator collapses under real-channel phase shifts.
- [ ] Make DSSS decodable without a phase reference: I/Q despreading plus differential encoding (DBPSK) or a carrier phase-tracking loop, since BPSK polarity inverts wholesale past a 90° phase offset.
- [ ] Add random delay/phase offsets to the channel simulator so phase-fragile demodulators fail in simulation the way they would over the air.

FSK now performs sync acquisition and CRC-validated live decoding. Add equivalent acquisition for CSS and DSSS before automatic mode classification.

## Messaging

- [ ] Define authenticated packet identities, sequencing, ACKs, and retry behavior.
- [ ] Add pairing and authenticated encryption.
- [ ] Build nearby text messaging on the validated acoustic profiles.
- [ ] Evaluate native mobile development only if background reception or audio routing becomes essential.
