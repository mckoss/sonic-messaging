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

A recording compares receivers against one captured waveform; testing a different transmitted modulation or encoding requires another capture. Single-configuration recording CRC counts alone are not packet delivery rates. Use shared-schedule experiments below to account for attempted transmissions. Received SNR measurements, batch comparisons, and physical-device regression datasets remain in `PLAN.md`.

The older **Replay visible audio** and **Replay FFT view** controls play sound through the speaker; **Decode recording** is the repeatable receiver experiment.


## Shared-schedule FSK experiments

1. In **Shared-schedule FSK experiment**, edit the trial table (tone count, baud, frequency spacing, amplitude), seeded payload length, and quiet guard. The default interleaves repeated configurations. Keep the complete schedule under 100 seconds.
2. **Save shared plan** and **Load shared plan** on both devices. Record distance, orientation, speaker volume and background conditions in the receiver's experiment notes. Stop ordinary listening before starting the experiment receiver; it uses the selected microphone.
3. Select **Start experiment receiver**, then promptly select **Transmit experiment** on the other device. A fixed 4-FSK checkpoint identifies the plan and trial before every test packet. The full waveform, including quiet guards, is generated in a Worker and played at the actual AudioContext sample rate. Receiver setting changes occur in quiet guards; checkpoints update the sample-clock schedule. No network connection or synchronized wall clocks are required.
4. The receiver records continuously and automatically finishes after the scheduled trial windows. **Stop experiment** also preserves a partial capture. Save **experiment WAV** and **experiment results** before leaving the page. The WAV embeds the plan and checkpoints/results; **Load experiment WAV** and **Replay experiment** repeat schedule-aware analysis using original captured samples.
5. Save the **transmitter log** and load it on the receiver. It reports the samples consumed by the playback worklet, including an exact count on interruption. Trials whose packets were not fully played are excluded. Without that log, delivery counts assume the transmitter completed the schedule. Playback consumption does not establish that a speaker was audible or unmuted.

Each trial reports independent sync acquisition, raw bit errors over the complete framed bitstream (sync, Golay-protected length, payload, CRC; padding excluded), CRC validity, and exact equality with the seeded payload. Unacquired packets fail message recovery and have unavailable BER; incomplete or unsynchronized windows are not scored. Payload FEC is explicitly **none** in this baseline; only the existing length header receives Golay correction. Per-configuration summaries aggregate measured trials, and exported JSON includes the receiver version and recording timestamp. These are not calibrated SNR measurements.

Checkpoints track schedule drift up to 1%; this does not yet correct frequency or symbol-clock offset within packets. If live DSP drops samples, the report flags timing as invalid; the original capture is retained before that drop and can be replayed for valid analysis. Capture is limited to two minutes including the wait for the transmitter. The browser tests use supplied microphone fixtures; physical devices and room conditions still require field validation.
