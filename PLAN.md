# Sonic Messaging development plan

## Current direction

Build experimental mode before further FSK tuning: first capture and replay real received audio, then automate controlled two-device trials, then use those recordings and measurements to optimize FSK. Keep experiments local to the static PWA with downloadable files and no required backend. Extend the same framework to other modulations and encodings as their live receivers become ready.

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
- [ ] Add comparable benchmark results through the experimental mode below. *(Saved user configurations are complete.)*

## Experimental mode and FSK optimization

### 1. Capture and replay real-device audio

- [x] Record lossless microphone PCM from the receiving device, including quiet intervals, failed transmissions, and sample positions. *(Two-minute limit; retained before live DSP backpressure.)*
- [x] Save/import a recording with sample rate, actual capture settings, app version, modem configuration, and device/browser, distance, orientation, speaker-volume, and background-noise notes. Request unprocessed capture where supported and record the settings actually applied.
- [x] Replay captured samples directly through the same Worker-based receiver path used by live audio, with repeatable reset and timing behavior; do not replay through a speaker and recapture the room.
- [x] Support paced replay with waterfalls, decoded text, CRC outcome counts, current FSK controls, and restoration of recorded settings.
- [ ] Add faster batch decoding and exported receiver-comparison results.
- [x] Verify lossless sample preservation, repeated noisy-waveform decoding, original sample-rate replay, cancellation/restart, and browser capture → download → import → decode on desktop/mobile layouts. *(Browser capture tests use a supplied audio fixture.)*
- [ ] Collect physical two-device recordings with expected packets and known failures for the field regression dataset.

Recordings preserve the acoustic conditions of a particular transmission. They allow comparison of decoder settings and implementations against identical input; a different transmitted modulation, encoding, or waveform requires a new capture. Keep original recordings unchanged and associate each replay result with its recording, decoder version, and settings.

### 2. Automate controlled two-device experiments

- [ ] Define a shared, versioned experiment file with known payloads, random seed, trial identifiers, modem/encoding settings, transmit amplitudes, repetitions, and quiet intervals. *(Current: next implementation milestone.)*
- [ ] Add transmitter and receiver roles on distinct devices at a fixed distance. Load the same experiment definition on both, start capture first, and establish the trial schedule with synchronization markers and clock-drift handling.
- [ ] Maintain a complete trial ledger independent of successful packet decoding, including missed transmissions and uncertain schedule alignment. Save transmitter execution results so interrupted runs do not count unsent trials as reception failures.
- [ ] Run an initial FSK transmit-amplitude sweep automatically, retaining the full received recording and trial metadata for replay.
- [ ] Estimate received in-band SNR from quiet-window noise power and scheduled signal-plus-noise power using the same analysis band. Retain raw power measurements, flag unresolved estimates near the noise floor, and distinguish transmit amplitude from measured SNR.
- [ ] Report acquisition rate, CRC-valid packet delivery, raw bit errors where alignment permits comparison, recovery after error correction, quiet-interval false detections, and delivered payload bits per elapsed second. Include trial counts, uncertainty, bandwidth, and airtime.
- [ ] Interleave configurations with a reproducible order to reduce bias from changing noise; support repeated runs and export per-trial and aggregate CSV/JSON results with recording references.

### 3. Optimize FSK using measured results

- [ ] Capture baseline FSK datasets across tone counts, tone spacing, frequency bands, symbol rates, payload lengths, and received SNR; compare reliability and useful throughput with bandwidth and airtime visible.
- [ ] Replay fixed recordings to evaluate acquisition and decoder changes, prioritizing observed failures and preserving regression cases.
- [ ] Estimate frequency offset and track sample-clock/symbol-timing drift, then validate improvements on the recorded baseline and fresh two-device runs.
- [ ] Add and compare payload error correction and interleaving against the uncoded baseline using new captures of each encoding.
- [ ] Select and document FSK profiles from measured reliability/throughput tradeoffs, then extend experiments to live CSS and DSSS once phase handling and acquisition are implemented.

## Live receiver

- [x] Add configured FSK raw-symbol detection and a symbol-likelihood waterfall.
- [x] Calibrate raw FSK likelihood against full-window energy so noise and partial-symbol matches are rejected.
- [x] ~~Add a configurable dBFS squelch for live FSK symbol detection and packet acquisition.~~ *(Removed to maximize range: the matched-filter sync needs no power gate, and mid-frame carrier-loss detection is now relative to the frame's own sync power.)*
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
- [x] Add robust preambles and physical-layer packet headers. *(Matched-filter sync acquisition over a low-autocorrelation CCSDS sync word accumulates soft per-symbol evidence, acquiring timing in noise too deep for hard-decision matching.)*
- [x] Detect FSK packet timing in the continuous microphone stream using sync-word phase acquisition.
- [ ] Estimate frequency/sample-clock offset and track packet timing. *(After the experimental baseline; see FSK optimization above.)*
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
