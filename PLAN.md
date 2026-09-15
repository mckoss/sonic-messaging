# Sonic Messaging development plan

## Current direction

Cooperative acoustic FSK experiments replace the shared-schedule runner. Use a stronger bidirectional control link to negotiate known-data trials and return raw errors for parameter search. Unknown timing belongs exclusively to receiver-side replay of the same recording. Keep raw symbol detection, acquisition, and payload FEC experiments separate. Next validate the cooperative link on two physical devices and estimate received SNR. Preserve the static PWA and downloadable recordings.

The workbench is divided into Send Single, Receive, Simulation, and Test Suite tabs. Each mode has a direct, mobile-friendly view while sharing the selected modem configuration in memory.

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
- [x] Split Send Single, Receive, Simulation, and Test Suite into accessible responsive tabs.
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

### 2. Cooperative controlled two-device experiments

- [x] Replace shared schedules with per-trial acoustic negotiation, readiness, sample-timed start/end markers, raw error feedback, acknowledgements and bounded retries.
- [x] Keep coordination on a fixed stronger 4-FSK profile; retry control messages without repeating measured transmissions.
- [x] Measure payload SER/BER from independent marker alignment even when test acquisition fails; retain confidence and confusion matrices.
- [x] Search base frequency, tone spacing or tone count using measured symbol error rates, repeated references and local refinement.
- [x] Record the real conversation, embed versioned configuration and measurements in WAV, and recompute from unchanged samples.
- [x] Evaluate unknown timing internally on the receiver using fresh decoder offsets; report acquisition/CRC/exact recovery independently. Payload FEC remains none.
- [x] Make the partner a settings-free passive listener that follows restarted controller runs and keeps listening until stopped; log each trial sent and the symbols received.
- [x] Receive test packets as ordinary frames on a second, temporary listener (received / CRC failed / lost); retire the `test` start marker, the guard setting and the internal acquisition replays.
- [x] Simplify the Test Suite: one **Start Test** run with a **Number of tests** (up to 100) and a duration estimate that warns past 10 minutes; test packets always play at amplitude 0.8.
- [x] Give every frame a UDP-like sender ID and type covered by the CRC; drop session IDs from messages and the end marker from trials.
- [x] Make control messages human-readable method calls (`test_suite`, `ready`, `test`, `end`, `result`, `query`, `ack`, `done`, `lost`) and report per-symbol in-window S/N with its median.
- [x] Log every message over the air on both devices (`<-` sent, `->` received, `X` garbled), unfiltered, with decoded meaning plus raw bytes as hex.
- [x] Allow 10-minute sessions: stream experiment recordings to IndexedDB in chunks, score from a rolling 60-second window, and list, replay, save, delete or clear saved recordings.
- [x] Retire shared-plan imports and transmitter logs; preserve historical WAV audio import in the general recording panel.
- [ ] Validate coordination reliability and parameter search on two physical devices; save field baselines. **Current: next milestone.**
- [ ] Estimate in-band SNR using quiet-window noise and signal-plus-noise power; distinguish measured SNR from transmitter amplitude.
- [ ] Add uncertainty intervals, CSV export, throughput/bandwidth comparisons and cross-run aggregation.
- [ ] Add payload FEC experiments separately, comparing correction against raw error rates with new transmitted waveforms.

### 3. Optimize FSK using measured results

- [ ] Capture baseline FSK datasets across tone counts, tone spacing, frequency bands, symbol rates, payload lengths, and received SNR; compare reliability and useful throughput with bandwidth and airtime visible.
- [ ] Replay fixed recordings to evaluate acquisition and decoder changes, prioritizing observed failures and preserving regression cases.
- [ ] Estimate frequency offset and track sample-clock/symbol-timing drift, then validate improvements on the recorded baseline and fresh two-device runs. *(Symbol timing: sync-header acquisition plus decision-directed transition tracking is implemented for live reception and trial scoring; frequency offset remains.)*
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

## Interoperable legacy modes (backlog)

- [ ] Add a Bell 103 compatibility mode: 300 baud asynchronous FSK with 8N1 start/stop framing and continuous phase, originate tones 1070 Hz space / 1270 Hz mark and answer tones 2025 Hz space / 2225 Hz mark. Send and receive plain ASCII with no sync word, length header or CRC, so it interoperates with real modems, acoustic couplers and software such as minimodem.
- [ ] Add amateur radio SSTV signaling as an analog mode: frequency-modulated luminance across 1500–2300 Hz with 1200 Hz sync pulses, preceded by the VIS header (1900 Hz leaders, 1200 Hz break and start/stop bits, 30 ms data bits at 1100 Hz for 1 and 1300 Hz for 0, even parity). Start with one common mode (e.g. Martin M1, Scottie S1 or Robot 36); encode images, and decode with sync tracking and slant correction.

## Messaging

- [ ] Define authenticated packet identities, sequencing, ACKs, and retry behavior.
- [ ] Add pairing and authenticated encryption.
- [ ] Build nearby text messaging on the validated acoustic profiles.
- [ ] Evaluate native mobile development only if background reception or audio routing becomes essential.
