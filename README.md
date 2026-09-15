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

1. On the receiving device select **Listen as partner**. The partner needs no settings: each trial request carries them, a restarted controller is followed immediately, and the partner keeps listening across runs until stopped or the 10-minute session limit. On the controller configure test tones, base frequency, spacing, baud and seeded payload; test packets always play at amplitude 0.8. Keep both devices at a fixed distance and volume; record environmental conditions in the notes.
2. Choose the parameter to vary (base frequency, tone spacing or number of tones) and the **Number of tests**, then select **Start Test**. The panel estimates how long the run takes without retries and warns when it would exceed the 10-minute session limit. The controller negotiates settings, waits for readiness, sends known data and receives raw symbol/bit error counts. On both devices the experiment log records everything that goes over the air: `<-` for each message sent, `->` for each message received, and `X` for a message heard but garbled (header unreadable, signal lost, or CRC failed), with the bytes that were heard. Each line gives the raw data, then its meaning (see Control protocol below); binary test packets are shown as bracketed hex. Repeats, garbled frames and other senders' traffic all appear; only a device's own transmissions heard back by its microphone are left out. Search explores the range, repeats reference settings and refines around the best measured symbol error rate. Equal error rates do not establish an optimum.
3. Both devices record their microphones continuously, and each run is saved to the browser's storage (IndexedDB) in 5-second chunks while it records, so it survives a reload. **Saved recordings** lists every run with its role, length, trial count and size; each can be replayed, saved as a WAV or deleted, and **Clear all** frees the storage. Save **experiment results** before leaving. Prefer the partner recording for receiver analysis. **Load experiment WAV** and **Replay experiment** recompute measurements without accessing audio hardware or changing environmental factors.

Coordination uses fixed 4-FSK at 100 baud, 1000–1600 Hz and amplitude 0.8, leaving headroom below clipping. Test packets use the same amplitude, 0.8. CRC, acknowledgements and bounded retries protect coordination; this is not a guarantee that the control profile works in every room. A missing reply is retried after 6 seconds, up to five times. Lost feedback causes a query for cached results, never retransmission of the measured waveform; if the partner never received the test packet it answers the query with `lost` and the controller proposes the same settings again as a new trial. Corrupted control messages (CRC failures) are reported in the experiment log. Quiet guards separate exchanges; the half-second guard before a test packet is its only, unannounced, delay.

### Frame format

Every transmission in every mode (Send, experiments, simulation) uses one frame, modeled on a UDP datagram:

```
[1A CF FC 1D]  sync marker (CCSDS)                    4 bytes
[LL LL LL]     payload length, Golay(24,12) protected  3 bytes
[SS SS]        sender ID                              2 bytes
[TT]           type                                   1 byte
payload                                               N bytes
[CC CC]        CRC-16 (CCITT, init FFFF)              2 bytes, over sender + type + payload
```

Lessons taken from UDP:

- **Addressing belongs in the header.** The sender ID is a random 16-bit number each device picks when the app opens, shown as 4 hex digits (e.g. `9F04`). Messages never repeat it.
- **Type works like a port.** It says which handler owns the payload, so each can change on its own: `01` control (text methods below), `02` test packet (binary), `03` message (text from the Send tab).
- **The checksum covers the addressing.** A corrupted sender or type fails the CRC like corrupted data.
- **Reliability is the application's job.** As in TFTP, trial numbers, `ack` and retries live in the control protocol, not the frame.
- **Headers stay small.** At 100 baud 4-FSK every byte is 40 ms of air, so there is no destination field yet; every frame is effectively broadcast. The header and CRC add 12 bytes to any payload.

A frame is surrounded by 0.5 s of silence. The Receive tab labels the sender as `FROM 9F04` in its RX lane and shows it with each decoded message.

### Control protocol

Control frames (type `01`) carry plain ASCII method calls. Trial numbers are 1-based; who sent a message comes from the frame. Each method is parsed independently, so methods can change without versioning the whole protocol.

| Method | Sent by | Meaning |
|---|---|---|
| `test_suite(T, base, delta, tones, baud, bytes, seed)` | controller | Settings for trial T; the partner opens a test listener on them |
| `ready(T)` | partner | Ready to measure trial T |
| `result(T, symbolErrors, symbols, bitErrors, bits, confidence, medianSnrDb, crcOk)` | partner | Scores for trial T; `crcOk` is 1 if the packet was received intact, 0 if heard but corrupted |
| `query(T)` | controller | No result heard; asks the partner to repeat it |
| `lost(T)` | partner | The test packet wasn't received; the controller re-proposes the settings as a new trial |
| `ack(T)` | controller | Result received |
| `done(N)` | controller | Run finished after N trials |

A trial runs `test_suite` → `ready` → test packet → `result` → `ack`. The test packet is an ordinary frame (type `02`) on the trial's settings with no marker around it, so a test measures ordinary packet reception:

- **Two listeners share the microphone stream.** The control listener always runs. Each `test_suite` opens a temporary test listener on the trial's tones and baud, until the packet is decoded or the window closes (its `ready` reply, the packet's air time, and 3 s of slack; a repeated `test_suite` restarts it). Each listener only locks onto frames with its own sync timing, and the frame type confirms what it caught.
- **Received:** the frame decoded and its CRC passed. **CRC failed:** the frame was heard but corrupted; its symbols are still scored from the decisions the receiver made. **Lost:** no sync header was heard in the window (or the header was unreadable); the partner answers `query` with `lost`.
- Once the listener hears the packet's sync, the partner stops retrying `ready`, so it never talks over a packet on the air.

The results table shows each trial's reception (received, CRC failed or lost), symbol errors and median S/N. The log's test packet line adds how far symbol tracking moved during the frame, e.g. `drift −0.1 ms`.

**Symbol timing tracking.** The FSK receiver locks timing to each frame's sync word, then tracks it through the frame without knowing the data: after each decision, a symbol that differs from both neighbors has a transition on each edge, and its tone's energy in windows shifted slightly early and late shows which way the true boundary lies. A slow integral term follows sample-clock drift, so long frames survive clock errors of 0.3% that a fixed grid can't. The partner follows the controller it last heard a `test_suite` from; the same controller counting trials back down to 1 is a restarted run.

The experiment log shows every frame as sender, raw data, then meaning, e.g. `<- 9F04 ready(1) · partner ready for trial 1`. A device's microphone also hears its own transmissions; frames carrying its own sender ID are dropped without logging, so they never reach the log, the session or scoring (on replay, the recording device's ID is used). When a test uses the control tones and baud, the control decoder also decodes the test packet; it is logged once, on the scored line. The partner's received test packet line lists the in-window S/N of every payload symbol in dB and its median, e.g. `-> 1A2B test packet [83 F9 …] · trial 1: received, 64/64 symbols received, S/N dB [24 22 19 …] median 21.4 · drift −0.1 ms`. S/N is broadband: the winning tone's coherent energy versus all other energy captured in that symbol window across the whole audio band (uncorrelated noise, hum, other tones), not versus the other tone bins alone. It can therefore read low while every symbol still decodes, because the detector only has to beat the competing tone bins.

Raw BER compares payload bits only; SER compares symbols wholly inside the payload. Confidence and tone confusion matrices are saved in results. Replaying a recording runs the same two listeners over its samples. Payload FEC is **none**; the existing length header uses Golay correction.

Sessions end after 10 minutes or the number of tests (up to 100), whichever comes first. Stop preserves partial captures; experiment capture is capped at 10 minutes (the Receive tab's recording stays capped at two). Live scoring keeps only the most recent 60 seconds of audio in memory, which spans any single trial. Capture loss aborts optimization and preserves recorded samples for replay. Received acoustic S/N, statistical uncertainty, cross-run aggregation and payload FEC comparisons remain planned. Physical two-device field validation remains necessary.

The shared-schedule runner and JSON plans are retired. Its older WAV audio remains importable through **Load recording WAV**, but schedule scoring and transmitter logs are no longer supported. Cooperative WAVs embed their new versioned configuration and measurements.
