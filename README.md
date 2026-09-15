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

A recording compares receivers against one captured waveform; testing a different transmitted modulation or encoding requires another capture. Single-configuration recording CRC counts alone are not packet delivery rates. Use cooperative experiments below for independently aligned raw error measurements. Received SNR measurements, batch comparisons, and physical-device regression datasets remain in `PLAN.md`.

The older **Replay visible audio** and **Replay FFT view** controls play sound through the speaker; **Decode recording** is the repeatable receiver experiment.


## Cooperative FSK experiments

1. On the receiving device select **Listen as partner**. The partner needs no settings: each trial request carries them, a restarted controller is followed immediately, and the partner keeps listening across runs until stopped or the 110-second session limit. On the controller configure test tones, base frequency, spacing, baud, amplitude and seeded payload. Keep both devices at a fixed distance and volume; record environmental conditions in the notes.
2. Select **Run one trial**, or choose base frequency, tone spacing or number of tones and select **Optimize**. The controller negotiates settings, waits for readiness, sends known data and receives raw symbol/bit error counts. The experiment log shows each trial sent (`<- Trial 1, Tones=4, Base=1000, Delta=200, Baud=100`) and each result (`-> Symbols received 64/64`), with arrows reversed on the partner. Search explores the range, repeats reference settings and refines around the best measured symbol error rate. Equal error rates do not establish an optimum.
3. Both devices record their microphones continuously, and each run is saved to the browser's storage (IndexedDB) in 5-second chunks while it records, so it survives a reload. **Saved recordings** lists every run with its role, length, trial count and size; each can be replayed, saved as a WAV or deleted, and **Clear all** frees the storage. Save **experiment results** before leaving. Prefer the partner recording for receiver analysis. **Load experiment WAV** and **Replay experiment** recompute measurements without accessing audio hardware or changing environmental factors.

Coordination uses fixed 4-FSK at 100 baud, 1000–1600 Hz and amplitude 0.8, leaving headroom below clipping. Tests use amplitude 0.01–0.5. CRC, acknowledgements and bounded retries protect coordination; this is not a guarantee that the control profile works in every room. A missing reply is retried after 4.5 seconds, up to five times. Lost feedback causes a query for cached results, never retransmission of the measured waveform; if the partner never heard both timing markers it answers the query with `lost` and the controller proposes the same settings again as a new trial. Corrupted control messages (CRC failures) are reported in the experiment log. Quiet guards separate exchanges. Each test is bracketed by two control timing markers in one sample-timed waveform; their observed positions establish payload alignment independently of the test's sync, including sample-clock scale correction within 1%. Missing or inconsistent markers leave a trial unscored.

Raw BER compares payload bits only; SER compares symbols wholly inside the payload. Confidence and tone confusion matrices are saved in results. Unknown timing is evaluated **only on the receiver**, using four fresh decoders started at different offsets within the same recorded quiet lead. Acquisition, CRC validity and exact message recovery are saved separately from raw error counts. These four replays are correlated observations of one transmission, not four physical packet deliveries. Payload FEC is **none**; the existing length header uses Golay correction.

Sessions end after 10 minutes or the trial budget, whichever comes first. Stop preserves partial captures; experiment capture is capped at 10 minutes (the Receive tab's recording stays capped at two). Live scoring keeps only the most recent 60 seconds of audio in memory, which spans any single trial. Capture loss aborts optimization and preserves recorded samples for replay. Received acoustic S/N, statistical uncertainty, cross-run aggregation and payload FEC comparisons remain planned. Physical two-device field validation remains necessary.

The shared-schedule runner and JSON plans are retired. Its older WAV audio remains importable through **Load recording WAV**, but schedule scoring and transmitter logs are no longer supported. Cooperative WAVs embed their new versioned configuration and measurements.
