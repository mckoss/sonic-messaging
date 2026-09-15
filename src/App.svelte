<script lang="ts">
  import { onMount } from 'svelte';
  import SpectrumDisplay from './lib/components/SpectrumDisplay.svelte';
  import SymbolWaterfall from './lib/components/SymbolWaterfall.svelte';
  import ExperimentPanel from './lib/components/ExperimentPanel.svelte';
  let experimentActive = false;
  import ModeControls from './lib/components/ModeControls.svelte';
  import { AudioEngine } from './lib/audio';
  import { ModemLabWorker, type SimulationResult } from './lib/modem-lab';
  import { fskFrequencies } from './lib/dsp';
  import { loadUserPreferences, saveUserPreferences, type Mode, type UserPreferences } from './lib/preferences';
  import { waterfallSamplesPerCssPixel } from './lib/audio/waterfall';
  import { replayPlaybackPosition, waterfallScrubSamples, waterfallView } from './lib/audio/scrub-store';
  import { get } from 'svelte/store';
  import { DEVICE_SENDER } from './lib/sender';
  import { ADDRESS_BYTES, FRAME_TYPE_NAMES, frameId, LENGTH_BYTES } from './lib/dsp/frame';
  import { RecordingCapture, encodeRecording, decodeRecording, MAX_RECORDING_BYTES, MAX_RECORDING_SECONDS,
    type Recording } from './lib/audio/recording';

  let captureSession: RecordingCapture | undefined;
  let recording: Recording | undefined;
  let recordingSeconds = 0;
  let recordingNotes = '';
  let recordingStatus = '';
  let recordingError = '';
  let replaying = false;
  let replayStopRequested = false;
  let replaySeconds = 0;
  let replayPackets = 0;
  let replayCrcErrors = 0;
  let receiverSession = 0;
  let receiverSampleRate = 48000;
  $: receiving = listening || replaying;


  let spectrum: Float32Array = new Float32Array(1024).fill(-110);
  let spectrumSequence = -1;
  let spectrumSamplePosition = -1;
  let receiverState: 'idle' | 'listening' | 'signal' = 'idle';
  let offlineReady = false;
  let installAvailable = false;
  let installPrompt: { prompt: () => Promise<void> } | undefined;
  let audio: AudioEngine;
  let lab: ModemLabWorker;
  let lastResult: SimulationResult | undefined;
  let busy = false;
  let symbolScores: Float32Array = new Float32Array(4);
  let symbolSequence = -1;
  let symbolSamplePosition = -1;
  let rawSymbol = -1;
  let symbolConfidence = 0;
  let symbolPower = -120;
  let receivedMessages: string[] = [];
  let receivingMessage = '';
  let receivedMarkers: Array<{ id: number; label: string; symbols: number; position: number }> = [];
  let symbolBackfill: Array<{ id: number; position: number; samplesPerSymbol: number; scores: number[]; confidence: number }> = [];
  let workerError = '';
  let receivedMarkerId = 0;
  let symbolBackfillId = 0;
  let receptionDecoder = new TextDecoder();
  let micSettings: MediaTrackSettings | undefined;
  // Browser processing stages that corrupt modem tones; all requested off.
  const MIC_PROCESSING: Array<{ key: 'autoGainControl' | 'echoCancellation' | 'noiseSuppression'; label: string }> = [
    { key: 'autoGainControl', label: 'AGC' },
    { key: 'echoCancellation', label: 'echo cancel' },
    { key: 'noiseSuppression', label: 'noise supp' }
  ];

  let mode: Mode = 'FSK';
  let listening = false;
  let payload = 'SONIC TEST 001';
  let settings: Record<Mode, Record<string, number | string | boolean>> = {
    FSK: { lowestFrequency: 500, toneSpacing: 100, tones: 4, symbolRate: 25 },
    CSS: { centerFrequency: 8000, bandwidth: 6000, spreadingFactor: 8, chirpDirection: 'Up', preambleSymbols: 8 },
    DSSS: { centerFrequency: 6000, bandwidth: 5000, codeFamily: 'Gold', codeLength: 127, codeIndex: 0, chipRate: 4000 }
  };
  let snr = 10;
  let noiseType = 'White noise';
  let interferer = false;
  let interfererPower = -6;
  let preferencesReady = false;
  type AppView = 'send' | 'receive' | 'simulation' | 'tests';
  const appViews: Array<{ id: AppView; label: string; detail: string }> = [
    { id: 'send', label: 'Send Single', detail: 'Compose & transmit' },
    { id: 'receive', label: 'Receive', detail: 'Listen & decode' },
    { id: 'simulation', label: 'Simulation', detail: 'Model the channel' },
    { id: 'tests', label: 'Test Suite', detail: 'Two-device trials' }
  ];
  let appView: AppView = 'send';
  let receiverWidth = 900, receiverClientWidth = 0;
  // A hidden tab measures 0 px; keep the last real width so switching tabs doesn't rescale and clear the waterfalls.
  $: if (receiverClientWidth > 0) receiverWidth = receiverClientWidth;
  // Quantize so window-resize jitter doesn't reset the waterfall rings each pixel.
  $: waterfallWidth = Math.max(280, Math.round((receiverWidth - 110) / 50) * 50);
  // Scroll speed follows the symbol rate: 64 symbols span one view width.
  $: samplesPerCssPixel = waterfallSamplesPerCssPixel(
    receiverSampleRate, Number(settings.FSK.symbolRate), waterfallWidth);
  let inputDeviceId = 'default';
  let inputDevices: Array<{ deviceId: string; label: string }> = [];
  let packets = [
    { time: '—', mode: 'Waiting', payload: 'No packets decoded yet', quality: '—' }
  ];
  let logs = ['Ready · Audio engine awaiting user interaction'];

  async function onTransmit(detail: { mode: Mode; payload: string; settings: Record<string, unknown> }) {
    busy = true;
    try {
      const waveform = await lab.encode({ ...detail, sender: DEVICE_SENDER });
      await audio.transmit(waveform.samples);
      const seconds = waveform.samples.length / waveform.sampleRate;
      logs = [`${new Date().toLocaleTimeString()} · TX ${mode} "${detail.payload}" · ${seconds.toFixed(1)} s of audio`, ...logs].slice(0, 10);
    } catch (error) {
      logs = [`Transmit error · ${error instanceof Error ? error.message : String(error)}`, ...logs].slice(0, 10);
    } finally { busy = false; }
  }

  async function onListenToggle(next: boolean) {
    try {
      if (next) {
        resetReceiverDisplay();
        try { await audio.startListening(inputDeviceId); }
        catch (error) {
          if (inputDeviceId === 'default') throw error;
          logs = [`Saved microphone unavailable · using system default`, ...logs].slice(0, 10);
          inputDeviceId = 'default'; persistPreferences(); await audio.startListening();
        }
      } else {
        finishRecording();
        audio.stopListening(); audio.disableDetector();
        // Abandon any packet mid-read in the display; the worker itself is
        // kept for history replay and replaced on the next start.
        receivingMessage = ''; receptionDecoder = new TextDecoder();
      }
      if (next) await refreshInputDevices(true);
      listening = next;
      micSettings = next ? audio.state.inputSettings : undefined;
      configureDetector();
      receiverState = next ? 'listening' : 'idle';
    } catch (error) {
      listening = false; receiverState = 'idle';
      logs = [`Receiver error · ${error instanceof Error ? error.message : String(error)}`, ...logs].slice(0, 10);
    }
  }

  async function onRunSimulation(detail: { mode: Mode; payload: string; settings: Record<string, unknown>; snr: number; interferer: boolean; interfererPower: number }) {
    logs = [`${new Date().toLocaleTimeString()} · Simulation started at ${snr} dB SNR`, ...logs].slice(0, 10);
    busy = true;
    try {
      lastResult = await lab.simulate(detail);
      spectrum = lastResult.spectrum;
      packets = [{ time: new Date().toLocaleTimeString(), mode,
        payload: lastResult.ok ? lastResult.decoded : lastResult.errors.join(', '),
        quality: `${Math.round(lastResult.confidence * 100)}%` }, ...packets.filter(p => p.mode !== 'Waiting')].slice(0, 6);
      logs = [`${lastResult.ok ? 'Decoded' : 'Rejected'} · ${lastResult.sampleCount.toLocaleString()} samples in ${lastResult.elapsedMs.toFixed(1)} ms`, ...logs].slice(0, 10);
    } catch (error) {
      logs = [`Simulation error · ${error instanceof Error ? error.message : String(error)}`, ...logs].slice(0, 10);
    } finally { busy = false; }
  }

  function fskSettings() {
    const s = settings.FSK;
    return { frequencies: fskFrequencies(Number(s.lowestFrequency), Number(s.toneSpacing), Number(s.tones)),
      symbolRate: Number(s.symbolRate) };
  }
  function resetReceiverDisplay() {
    receiverSession++;
    spectrum = new Float32Array(1024).fill(-110); spectrumSequence = -1; spectrumSamplePosition = -1;
    symbolScores = new Float32Array(Number(settings.FSK.tones)); symbolSequence = -1; symbolSamplePosition = -1;
    rawSymbol = -1; symbolConfidence = 0; symbolPower = -120;
    receivedMessages = []; receivingMessage = ''; receivedMarkers = []; symbolBackfill = [];
    receptionDecoder = new TextDecoder(); workerError = '';
    packets = [{ time: '—', mode: 'Waiting', payload: 'No packets decoded yet', quality: '—' }];
    waterfallScrubSamples.set(0); waterfallView.set({ position: -1, viewSamples: 0 });
    replayPlaybackPosition.set(-1);
  }
  async function startRecording() {
    recordingError = ''; recordingStatus = ''; busy = true;
    if (!listening) await onListenToggle(true);
    if (!listening) { recordingError = 'Microphone unavailable; see receiver log.'; busy = false; return; }
    try {
      captureSession = new RecordingCapture({ format: 'sonic-recording', version: 1,
        createdAt: new Date().toISOString(), appVersion: __APP_VERSION__, sampleRate: receiverSampleRate,
        fsk: fskSettings(), inputSettings: { ...micSettings }, userAgent: navigator.userAgent, notes: recordingNotes });
      recording = undefined; recordingSeconds = 0; replaySeconds = 0;
      recordingStatus = 'Recording microphone audio…';
    } catch (error) { recordingError = String(error); }
    finally { busy = false; }
  }
  function finishRecording() {
    if (!captureSession) return;
    recording = captureSession.finish(); captureSession = undefined;
    recordingStatus = recording.samples.length ? 'Recording ready to save or decode.' : 'No audio captured.';
  }
  function saveRecording() {
    if (!recording) return;
    try {
      const url = URL.createObjectURL(new Blob([encodeRecording(recording)], { type: 'audio/wav' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `sonic-recording-${recording.metadata.createdAt.replace(/[^0-9TZ]/g, '-')}.wav`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { recordingError = String(error); }
  }
  async function loadRecording(event: Event) {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    recordingError = ''; busy = true;
    try {
      if (file.size > MAX_RECORDING_BYTES) throw new Error('Recording file exceeds the 100 MB import limit');
      const loaded = decodeRecording(await file.arrayBuffer());
      if (loaded.metadata.cooperative) throw new Error('Use Load experiment WAV in the cooperative panel for this recording');
      if (listening) await onListenToggle(false);
      replaySeconds = 0;
      recording = loaded; recordingSeconds = loaded.samples.length / loaded.metadata.sampleRate;
      recordingNotes = loaded.metadata.notes;
      applyRecordedSettings();
      recordingStatus = 'Recording loaded; saved FSK settings restored.';
    } catch (error) { recordingError = error instanceof Error ? error.message : String(error); }
    finally { input.value = ''; busy = false; }
  }
  function applyRecordedSettings() {
    if (!recording) return;
    const fsk = recording.metadata.fsk;
    mode = 'FSK'; settings = { ...settings, FSK: { lowestFrequency: fsk.frequencies[0],
      toneSpacing: fsk.frequencies[1] - fsk.frequencies[0], tones: fsk.frequencies.length, symbolRate: fsk.symbolRate } };
  }
  async function decodeSavedRecording() {
    if (!recording) return;
    if (listening) await onListenToggle(false);
    recordingError = ''; replaySeconds = 0; replayPackets = 0; replayCrcErrors = 0;
    resetReceiverDisplay(); replayStopRequested = false; replaying = true;
    recordingStatus = 'Decoding recording…';
    try {
      await audio.replayRecording(recording, fskSettings(), seconds => replaySeconds = seconds);
      recordingStatus = replayStopRequested ? 'Replay stopped.' : 'Replay complete.';
    } catch (error) { recordingError = error instanceof Error ? error.message : String(error); }
    finally { replaying = false; receiverState = 'idle'; }
  }
  function stopRecordedReplay() { replayStopRequested = true; audio.stopReplay(); }

  function transmit() { void onTransmit({ mode, payload, settings: { ...settings[mode] } }); }
  // Zoom the spectrogram to the band in use plus a 10% margin on each side.
  $: activeBand = (() => {
    const s = settings[mode];
    if (mode === 'FSK') {
      const low = Number(s.lowestFrequency);
      return { low, high: low + Number(s.toneSpacing) * (Number(s.tones) - 1) };
    }
    const center = Number(s.centerFrequency), half = Number(s.bandwidth) / 2;
    return { low: center - half, high: center + half };
  })();
  $: spectrumMin = Math.max(0, activeBand.low - 0.1 * (activeBand.high - activeBand.low));
  $: spectrumMax = Math.min(24000, activeBand.high + 0.1 * (activeBand.high - activeBand.low));
  function currentPreferences(): UserPreferences {
    return { mode, settings, snr, noiseType, interferer, interfererPower, inputDeviceId, payload };
  }
  function persistPreferences() {
    if (preferencesReady) saveUserPreferences(window.localStorage, currentPreferences());
  }
  function onSettingsChange() {
    settings = settings; // ModeControls mutates in place; reassign so labels and props re-render.
    configureDetector(); persistPreferences();
  }
  async function refreshInputDevices(validateSelection = false) {
    try {
      const devices = await audio.listInputDevices();
      inputDevices = devices.filter(device => device.deviceId !== 'default').map((device, index) => ({
        deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}`
      }));
      if (validateSelection && inputDeviceId !== 'default' && !inputDevices.some(device => device.deviceId === inputDeviceId)) {
        inputDeviceId = 'default'; persistPreferences();
      }
    } catch (error) {
      logs = [`Microphone list error · ${error instanceof Error ? error.message : String(error)}`, ...logs].slice(0, 10);
    }
  }
  async function onInputDeviceChange() {
    persistPreferences();
    if (listening) {
      audio.stopListening(); listening = false;
      await onListenToggle(true);
    }
  }
  function configureDetector() {
    if (!audio || !listening || mode !== 'FSK') { audio?.disableDetector(); return; }
    const s = settings.FSK;
    audio.configureFskDetector(
      fskFrequencies(Number(s.lowestFrequency), Number(s.toneSpacing), Number(s.tones)),
      Number(s.symbolRate)
    );
  }
  function selectMode(next: Mode) { mode = next; configureDetector(); persistPreferences(); }
  async function replayVisible(replayMode: 'raw' | 'fft') {
    busy = true;
    try {
      if (listening) await onListenToggle(false);
      const view = get(waterfallView);
      if (view.position < 0) {
        logs = [`${new Date().toLocaleTimeString()} · No capture history yet — start listening first`, ...logs].slice(0, 10);
        return;
      }
      const to = Math.max(0, view.position - get(waterfallScrubSamples));
      const from = Math.max(0, to - view.viewSamples);
      const captured = await audio.requestCapturedAudio(from, to, replayMode);
      if (!captured.samples.length) {
        logs = [`${new Date().toLocaleTimeString()} · No captured audio in the visible window`, ...logs].slice(0, 10);
        return;
      }
      const seconds = captured.samples.length / captured.sampleRate;
      logs = [`${new Date().toLocaleTimeString()} · Replaying ${seconds.toFixed(1)} s of ${replayMode === 'fft' ? 'FFT-reconstructed' : 'captured'} audio`, ...logs].slice(0, 10);
      await audio.transmit(captured.samples);
      startReplaySweep(to - captured.samples.length, to, captured.sampleRate);
    } catch (error) {
      logs = [`Replay error · ${error instanceof Error ? error.message : String(error)}`, ...logs].slice(0, 10);
    } finally { busy = false; }
  }
  let replaySweepFrame = 0;
  /** Sweep the waterfall playback cursor across [from, to] on the capture clock in real time. */
  function startReplaySweep(from: number, to: number, sampleRate: number) {
    cancelAnimationFrame(replaySweepFrame);
    const startedAt = performance.now();
    const step = (now: number) => {
      replayPlaybackPosition.set(Math.min(from + ((now - startedAt) / 1000) * sampleRate, to));
      replaySweepFrame = requestAnimationFrame(step);
    };
    replaySweepFrame = requestAnimationFrame(step);
    void audio.waitForPlayback().then(() => {
      cancelAnimationFrame(replaySweepFrame);
      replayPlaybackPosition.set(-1);
    });
  }
  function toggleListen() { void onListenToggle(!listening); }
  function simulate() { void onRunSimulation({ mode, payload, settings: { ...settings[mode] }, snr, interferer, interfererPower }); }
  function onInstall() { void installPrompt?.prompt(); }
  function viewFromHash(): AppView | undefined {
    const value = window.location.hash.slice(1);
    return appViews.some(view => view.id === value) ? value as AppView : undefined;
  }
  function selectAppView(next: AppView) {
    appView = next;
    window.history.replaceState(null, '', `#${next}`);
  }
  function onAppViewKeydown(event: KeyboardEvent, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? appViews.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + appViews.length) % appViews.length;
    selectAppView(appViews[nextIndex].id);
    document.getElementById(`app-tab-${appViews[nextIndex].id}`)?.focus();
  }

  onMount(() => {
    appView = viewFromHash() ?? appView;
    const hashHandler = () => { appView = viewFromHash() ?? 'send'; };
    window.addEventListener('hashchange', hashHandler);
    const restored = loadUserPreferences(window.localStorage, currentPreferences());
    mode = restored.mode; settings = restored.settings; snr = restored.snr; noiseType = restored.noiseType;
    interferer = restored.interferer; interfererPower = restored.interfererPower;
    inputDeviceId = restored.inputDeviceId; payload = restored.payload;
    preferencesReady = true;
    audio = new AudioEngine(); lab = new ModemLabWorker();
    void refreshInputDevices(false);
    const offState = audio.onState(state => { receiverSampleRate = state.sampleRate ?? 48000; });
    const offCapture = audio.onCapture(event => {
      if (!captureSession) return;
      try {
        const full = captureSession.append(event.samples, event.sampleRate, event.sequence);
        // Render only tenths of a second, not every audio quantum.
        recordingSeconds = Math.floor(captureSession.seconds * 10) / 10;
        if (full) { finishRecording(); recordingStatus = 'Two-minute limit reached; recording ready to save.'; }
      } catch (error) { finishRecording(); recordingError = String(error); }
    });
    const offHealth = audio.onWorkerHealth(event => {
      workerError = event.healthy ? '' : event.reason ?? 'DSP worker unresponsive';
    });
    const offSpectrum = audio.onSpectrum(event => { spectrum = event.bins; spectrumSequence = event.sequence;
      spectrumSamplePosition = event.samplePosition; receiverState = 'signal'; });
    const offSymbols = audio.onSymbols(event => {
      symbolScores = event.scores; symbolSequence = event.sequence; rawSymbol = event.symbol;
      symbolSamplePosition = event.samplePosition; symbolConfidence = event.confidence; symbolPower = event.powerDbfs;
    });
    const offPackets = audio.onPackets(event => {
      // The worker survives a stop for history replay; anything its queued
      // backlog still decodes afterward must not reach the display.
      if (!listening && !replaying) return;
      if (replaying) replayPackets++;
      const decoded = new TextDecoder('utf-8', { fatal: true });
      try {
        const text = decoded.decode(event.payload);
        const type = event.frameType === 0x03 ? '' : ` ${FRAME_TYPE_NAMES[event.frameType] ?? `type ${event.frameType}`}`;
        packets = [{ time: new Date().toLocaleTimeString(), mode: event.mode, payload: `${frameId(event.sender, event.seq)}${type}: ${text}`,
          quality: `${Math.round(event.confidence * 100)}%` }, ...packets.filter(p => p.mode !== 'Waiting')].slice(0, 6);
      } catch {
        logs = [`${new Date().toLocaleTimeString()} · RX FSK frame with valid CRC rejected: payload is not UTF-8 text`, ...logs].slice(0, 10);
      }
    });
    const offReception = audio.onReception(event => {
      if (!listening && !replaying) return;
      const bitsPerSymbol = Math.log2(Number(settings.FSK.tones));
      const addMarker = (label: string, byteCount: number) => {
        receivedMarkers = [...receivedMarkers, {
          id: receivedMarkerId++, label: label === ' ' ? '⎵' : label,
          symbols: byteCount * 8 / bitsPerSymbol, position: event.position
        }].slice(-64);
      };
      if (event.token === 'sync') {
        receptionDecoder = new TextDecoder(); receivingMessage = '';
        addMarker('<SYNC>', 4);
      } else if (event.token === 'length') {
        addMarker(`LEN ${event.length ?? '?'}`, LENGTH_BYTES);
      } else if (event.token === 'address') {
        addMarker(`FROM ${frameId(event.sender ?? 0, event.seq ?? 0)}`, ADDRESS_BYTES);
      } else if (event.token === 'crc-confirm') {
        receivedMessages = [...receivedMessages, `${receivingMessage} ✓`].slice(-24); receivingMessage = '';
        addMarker('✓', 2);
      } else if (event.token === 'crc-error') {
        if (replaying) replayCrcErrors++;
        receivedMessages = [...receivedMessages, `${receivingMessage} ✕`].slice(-24); receivingMessage = '';
        addMarker('✕', 2);
      } else if (event.byte !== undefined) {
        // The RX lane is a single line; render decoded newlines as spaces.
        const text = receptionDecoder.decode(Uint8Array.of(event.byte), { stream: true }).replace(/[\r\n]/g, ' ');
        if (text) {
          const characters = [...text];
          for (const character of characters) {
            const byteCount = new TextEncoder().encode(character).length;
            addMarker(character, byteCount);
          }
          receivingMessage += text;
        }
      }
    });
    const offCaptureGaps = audio.onCaptureGaps(event => {
      const ms = Math.round(event.samples / event.sampleRate * 1000);
      logs = [event.source === 'backpressure'
        ? `${new Date().toLocaleTimeString()} · ⚠ DSP overload · dropped ${ms} ms of audio while the decoder lagged`
        : `${new Date().toLocaleTimeString()} · ⚠ Capture dropouts · ${ms} ms of zeroed audio — OS/browser pipeline glitch`,
        ...logs].slice(0, 10);
    });
    const offBackfill = audio.onSymbolBackfill(event => {
      symbolBackfill = [...symbolBackfill, ...event.slots.map(slot => ({
        id: symbolBackfillId++, position: slot.position, samplesPerSymbol: event.samplesPerSymbol,
        scores: slot.scores, confidence: slot.confidence
      }))].slice(-128);
    });
    const installHandler = (event: Event) => { event.preventDefault(); installPrompt = event as Event & { prompt: () => Promise<void> }; installAvailable = true; };
    window.addEventListener('beforeinstallprompt', installHandler);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(() => { offlineReady = true; });
    return () => { offState(); offCapture(); offHealth(); offSpectrum(); offSymbols(); offPackets(); offReception(); offCaptureGaps(); offBackfill(); void audio.dispose(); lab.dispose(); window.removeEventListener('beforeinstallprompt', installHandler); window.removeEventListener('hashchange', hashHandler); };
  });
</script>

<svelte:head><title>Sonic Messaging · Acoustic Modem Test Bed</title><meta name="theme-color" content="#07101d" /></svelte:head>

<header>
  <a class="brand" href={import.meta.env.BASE_URL} aria-label="Sonic Messaging home"><span class="mark">≋</span><span class="brand-copy"><span>Sonic <b>Messaging</b></span><small>v{__APP_VERSION__}</small></span></a>
  <div class="app-state">
    <span class:ready={offlineReady} class="dot"></span><span>{offlineReady ? 'Offline ready' : 'Online'}</span>
    {#if installAvailable}<button class="install" on:click={onInstall}>Install app</button>{/if}
  </div>
</header>

<main>
  <section class="intro"><div><p class="eyebrow">ACOUSTIC MODEM WORKBENCH</p><h1>Shape signals. Test channels.<br /><em>Hear what survives.</em></h1><p>Explore modulation, coding, and multi-user rejection across real and simulated acoustic channels.</p></div><div class="status-pill"><span class:live={listening || receiverState !== 'idle'}></span>{replaying ? 'Recording replay' : listening ? 'Microphone live' : 'Audio idle'}</div></section>

  <div class="app-tabs" role="tablist" aria-label="Application mode">
    {#each appViews as view, index}
      <button type="button" id="app-tab-{view.id}" role="tab" aria-controls="app-panel-{view.id}" aria-selected={appView === view.id}
        tabindex={appView === view.id ? 0 : -1} class:active={appView === view.id}
        disabled={experimentActive && appView !== view.id} on:click={() => selectAppView(view.id)} on:keydown={(event) => onAppViewKeydown(event, index)}>
        {view.label}<small>{view.detail}</small>
      </button>
    {/each}
  </div>

  <fieldset disabled={experimentActive}>
  <div id="app-panel-send" class="app-panel composer-page" role="tabpanel" aria-labelledby="app-tab-send" hidden={appView !== 'send'}>
    <section class="card composer">
      <div class="section-head"><div><span class="step">TX</span><h2>Signal composer</h2></div><span class="hint">48 kHz pipeline</span></div>
      <div class="tabs" role="tablist" aria-label="Modulation mode">{#each ['FSK','CSS','DSSS'] as item}<button role="tab" disabled={!!captureSession || replaying} aria-selected={mode === item} class:active={mode === item} on:click={() => selectMode(item as Mode)}>{item}<small>{item === 'FSK' ? 'Multi-tone' : item === 'CSS' ? 'Chirp spread' : 'Code spread'}</small></button>{/each}</div>
      <fieldset disabled={!!captureSession || replaying} on:change={onSettingsChange}><ModeControls {mode} settings={settings[mode]} /></fieldset>
      <label class="payload"><span>Test payload <small>{new TextEncoder().encode(payload).length} bytes</small></span><textarea bind:value={payload} maxlength="256" rows="3" on:input={persistPreferences}></textarea></label>
      <button class="primary" disabled={!payload || busy || replaying} on:click={transmit}><span>▶</span> {busy ? 'Processing…' : 'Transmit test packet'}</button>
    </section>
  </div>

  <div id="app-panel-receive" class="app-panel" role="tabpanel" aria-labelledby="app-tab-receive" hidden={appView !== 'receive'}>
    <section class="card receiver" bind:clientWidth={receiverClientWidth}>
      <div class="section-head"><div><span class="step">RX</span><h2>Receiver</h2></div><div class="receiver-actions"><label>Mic <select disabled={!!captureSession || replaying} bind:value={inputDeviceId} on:change={onInputDeviceChange} aria-label="Microphone"><option value="default">System default</option>{#each inputDevices as device}<option value={device.deviceId}>{device.label}</option>{/each}</select></label><span class="badge {receiverState}">{receiverState}</span></div></div>
      {#if workerError}<div class="worker-error" role="alert" data-testid="worker-error">⚠ Receiver stalled · {workerError}</div>{/if}
      {#key receiverSession}
      <SpectrumDisplay {spectrum} sequence={spectrumSequence} samplePosition={spectrumSamplePosition} live={receiving}
        {samplesPerCssPixel} sampleRate={receiverSampleRate} minFrequency={spectrumMin} maxFrequency={spectrumMax} />
      {#if mode === 'FSK'}
        <div class="detector-head"><span>FSK symbol likelihood</span><small>Sync acquisition + CRC packet decoding</small></div>
        <SymbolWaterfall scores={symbolScores} sequence={symbolSequence} live={receiving}
          messages={receivedMessages} currentMessage={receivingMessage} markers={receivedMarkers} backfill={symbolBackfill} confidence={symbolConfidence}
          samplePosition={symbolSamplePosition} {samplesPerCssPixel}
          sampleRate={receiverSampleRate}
          symbolRate={Number(settings.FSK.symbolRate)}
          labels={fskFrequencies(Number(settings.FSK.lowestFrequency), Number(settings.FSK.toneSpacing), Number(settings.FSK.tones)).map((frequency, index) => `S${index} · ${frequency}Hz`)} />
      {/if}
      {/key}
      <div class="readouts"><div><span>{mode === 'FSK' && receiving ? 'Window power' : 'Peak'}</span><strong>{mode === 'FSK' && receiving ? symbolPower.toFixed(1) : spectrum.length ? Math.max(...spectrum).toFixed(1) : '—'} dBFS</strong></div><div><span>{mode === 'FSK' && receiving ? 'Symbol confidence' : 'Last confidence'}</span><strong>{mode === 'FSK' && receiving ? `${Math.round(symbolConfidence * 100)}%` : lastResult ? `${Math.round(lastResult.confidence * 100)}%` : '—'}</strong></div><div><span>Decoder</span><strong>{receiving ? mode === 'FSK' ? rawSymbol >= 0 ? `FSK · S${rawSymbol}` : 'FSK · noise' : mode : 'Standby'}</strong></div></div>
      {#if listening && micSettings}
        <div class="mic-settings" data-testid="mic-settings">
          <span>Mic{micSettings.sampleRate ? ` · ${(micSettings.sampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz` : ''}</span>
          {#each MIC_PROCESSING as stage}
            <span class:on={micSettings[stage.key] === true}>{micSettings[stage.key] === undefined ? `${stage.label} ?` : micSettings[stage.key] ? `⚠ ${stage.label} ON` : `${stage.label} off`}</span>
          {/each}
        </div>
      {/if}
      <button disabled={replaying} class:stop={listening} class="listen" on:click={toggleListen}>{listening ? '■ Stop listening' : '◉ Start listening'}</button>
      <div class="replay-row"><button class="replay" disabled={busy || replaying || !!captureSession} on:click={() => void replayVisible('raw')}>▶ Replay visible audio</button><button class="replay" disabled={busy || replaying || !!captureSession} on:click={() => void replayVisible('fft')}>▶ Replay FFT view</button></div>
      <div class="recording-panel">
        <h3>Record &amp; decode</h3>
        <p>Save up to {MAX_RECORDING_SECONDS / 60} minutes of microphone audio. Replay into the receiver without using the speaker.</p>
        <label>Recording notes <textarea bind:value={recordingNotes} on:input={() => { if (recording) recording = { ...recording, metadata: { ...recording.metadata, notes: recordingNotes } }; }} disabled={!!captureSession || replaying} maxlength="4000" rows="2" placeholder="Devices, distance, orientation, volume, background noise"></textarea></label>
        <div class="replay-row">
          {#if captureSession}<button class="replay" on:click={finishRecording}>■ Stop recording</button>
          {:else}<button class="replay" disabled={mode !== 'FSK' || busy || replaying} on:click={startRecording}>● Record microphone</button>{/if}
          <button class="replay" disabled={!recording?.samples.length || replaying} on:click={saveRecording}>Save recording WAV</button>
        </div>
        <label class="recording-file">Load recording WAV <input type="file" accept=".wav,audio/wav" disabled={!!captureSession || replaying || busy} on:change={loadRecording} /></label>
        {#if mode !== 'FSK'}<p>Select FSK to record and decode.</p>{/if}
        {#if recording}
          <p>{recording.samples.length / recording.metadata.sampleRate < 1 ? '<1' : (recording.samples.length / recording.metadata.sampleRate).toFixed(1)} s · {recording.metadata.sampleRate.toLocaleString()} Hz · recorded with v{recording.metadata.appVersion}</p>
          <div class="replay-row">
            {#if replaying}<button class="replay" on:click={stopRecordedReplay}>■ Stop decoding</button>
            {:else}<button class="replay" disabled={!recording.samples.length || busy || mode !== 'FSK'} on:click={decodeSavedRecording}>▶ Decode recording</button>{/if}
            <button class="replay" disabled={replaying} on:click={applyRecordedSettings}>Restore recorded FSK settings</button>
          </div>
          <p>Decoding uses the current FSK controls. Loading restores the recorded settings.</p>
        {/if}
        <p role="status" data-testid="recording-status">{recordingStatus}{captureSession ? ` ${recordingSeconds.toFixed(1)} s` : ''}</p>
        {#if replaySeconds > 0}<p data-testid="recording-results">{replaySeconds.toFixed(1)} s decoded · {replayPackets} CRC-valid packets · {replayCrcErrors} CRC failures</p>{/if}
        {#if recordingError}<p role="alert">{recordingError}</p>{/if}
      </div>
    </section>
  </div>

  <div id="app-panel-simulation" class="app-panel" role="tabpanel" aria-labelledby="app-tab-simulation" hidden={appView !== 'simulation'}>
  <div class="layout">
    <section class="card simulation" on:change={persistPreferences}>
      <div class="section-head"><div><span class="step">SIM</span><h2>Channel simulation</h2></div><span class="hint">Worker isolated</span></div>
      <div class="signal-summary"><span>Current signal</span><strong>{mode} · {new TextEncoder().encode(payload).length} byte payload</strong><button class="text-button" on:click={() => selectAppView('send')}>Edit signal</button></div>
      <div class="sim-grid"><label><span>SNR <output>{snr} dB</output></span><input type="range" min="-30" max="40" bind:value={snr} /></label><label><span>Noise model</span><select bind:value={noiseType}><option>White noise</option><option>Pink noise</option><option>Impulse noise</option><option>Room response</option></select></label></div>
      <label class="switch-row"><input type="checkbox" bind:checked={interferer} /><span><b>Competing transmitter</b><small>Add an overlapping user with a different code or packet.</small></span></label>
      {#if interferer}<label class="interference"><span>Interferer relative power <output>{interfererPower} dB</output></span><input type="range" min="-30" max="20" bind:value={interfererPower} /></label>{/if}
      <button class="secondary" disabled={busy || replaying || !!captureSession} on:click={simulate}>{busy ? 'Running…' : 'Run encode → channel → decode'}</button>
    </section>

    <section class="card results">
      <div class="section-head"><div><span class="step">OUT</span><h2>Results</h2></div><button class="text-button" on:click={() => logs = []}>Clear log</button></div>
      <div class="metrics"><div><strong>{lastResult ? (lastResult.ok ? '0%' : '100%') : '—'}</strong><span>Packet error</span></div><div><strong>{lastResult?.userScores ? lastResult.userScores[0]?.index ?? '—' : '—'}</strong><span>Top DSSS user</span></div><div><strong>{lastResult ? `${lastResult.elapsedMs.toFixed(1)}ms` : '—'}</strong><span>Decode time</span></div></div>
      <div class="packet-list" aria-live="polite">{#each packets as packet}<article><time>{packet.time}</time><span class="packet-mode">{packet.mode}</span><code>{packet.payload}</code><span>{packet.quality}</span></article>{/each}</div>
      <div class="log">{#each logs as entry}<p>{entry}</p>{:else}<p class="empty">Log cleared</p>{/each}</div>
    </section>
  </div>
  </div>
  </fieldset>
  <div id="app-panel-tests" class="app-panel" role="tabpanel" aria-labelledby="app-tab-tests" hidden={appView !== 'tests'}>
  <ExperimentPanel bind:active={experimentActive} unavailable={listening || replaying || !!captureSession || busy}
    {inputDeviceId} beforeStart={async () => { if (listening) await onListenToggle(false); audio.stopTransmission(); }} />
  </div>
</main>

<footer><span>Sonic Messaging · local-first experiment</span><span>Microphone data stays on this device</span></footer>

<style>
  :global(*) { box-sizing: border-box; }
  :global(:root) { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: var(--text); background: #060d17; --text:#eaf2fb; --muted:#a4b2c5; --dim:#6f8199; --line:#203149; --field:#0b1727; --card:#0b1524; --accent:#4ee8b4; --blue:#67a7ff; }
  :global(body) { margin: 0; min-width: 320px; min-height: 100vh; background: radial-gradient(circle at 70% -10%, #12345a 0, transparent 33%), #060d17; }
  :global(button), :global(input), :global(select), :global(textarea) { font: inherit; }
  :global(button:focus-visible), :global(input:focus-visible), :global(select:focus-visible), :global(textarea:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  header { height: 64px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; padding: 0 max(20px, calc((100vw - 1320px)/2)); background: rgba(6,13,23,.84); backdrop-filter: blur(16px); position: sticky; top:0; z-index:10; }
  .brand { display:flex; align-items:center; gap:10px; color:var(--text); text-decoration:none; font-weight:700; letter-spacing:-.02em; }.brand b{color:var(--accent)}.brand-copy{display:grid;line-height:1.05}.brand-copy small{margin-top:3px;color:var(--dim);font:500 9px/1 ui-monospace,monospace;letter-spacing:.04em}.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:var(--accent);color:#06130f;font-size:25px;font-weight:900}
  .install,.text-button{border:0;background:transparent;color:var(--muted);cursor:pointer}
  .app-state{justify-self:end;display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:#f5b84b}.dot.ready{background:var(--accent)}.install{color:var(--accent);margin-left:8px}
  main { max-width:1320px; margin:auto; padding:56px 24px 72px; }.intro{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:34px}.eyebrow{color:var(--accent)!important;font:700 11px ui-monospace,monospace;letter-spacing:.18em}.intro h1{font-size:clamp(34px,5vw,58px);line-height:1.04;letter-spacing:-.045em;margin:8px 0 15px}.intro h1 em{font-style:normal;color:#84b9ff}.intro p{color:var(--muted);max-width:680px;line-height:1.6;margin:0}.status-pill{display:flex;align-items:center;gap:9px;border:1px solid var(--line);padding:9px 12px;border-radius:99px;color:var(--muted);font-size:12px;white-space:nowrap}.status-pill span{width:8px;height:8px;border-radius:50%;background:#506078}.status-pill span.live{background:var(--accent);box-shadow:0 0 0 4px #4ee8b422}
  .app-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;position:sticky;top:76px;z-index:9;margin-bottom:22px;padding:6px;border:1px solid var(--line);border-radius:15px;background:rgba(7,17,30,.94);backdrop-filter:blur(16px)}.app-tabs button{min-width:0;border:1px solid transparent;border-radius:10px;padding:10px 8px;background:transparent;color:var(--muted);font-weight:750;cursor:pointer}.app-tabs button small{display:block;margin-top:3px;color:var(--dim);font-size:10px;font-weight:500}.app-tabs button.active{border-color:#375272;background:#152740;color:var(--text)}.app-tabs button.active small{color:#9eb3cc}.app-tabs button:disabled{cursor:default}.app-panel[hidden]{display:none}.composer-page .composer{max-width:760px;margin:auto}
  .layout{display:grid;grid-template-columns:1.05fr .95fr;gap:18px;align-items:start}.card{background:linear-gradient(145deg,rgba(15,29,48,.94),rgba(8,18,31,.96));border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 40px #0003}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.section-head>div{display:flex;align-items:center;gap:10px}.section-head h2{font-size:16px;margin:0}.step{font:11px ui-monospace,monospace;color:var(--accent);border:1px solid #4ee8b444;border-radius:6px;padding:4px}.hint{font-size:11px;color:var(--dim)}
  .tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:5px;background:#07111e;border-radius:12px;margin-bottom:24px}.tabs button{border:1px solid transparent;border-radius:9px;padding:9px;background:transparent;color:var(--muted);font-weight:750;cursor:pointer}.tabs button small{display:block;font-size:10px;font-weight:500;color:var(--dim);margin-top:2px}.tabs button.active{border-color:#375272;background:#152740;color:var(--text)}.tabs button.active small{color:#9eb3cc}
  .payload{display:grid;gap:8px;margin-top:22px}.payload>span,.sim-grid label>span,.interference>span{display:flex;justify-content:space-between;color:var(--muted);font-size:13px;font-weight:650}.payload textarea{resize:vertical;color:var(--text);background:var(--field);border:1px solid var(--line);border-radius:10px;padding:12px}.payload small{color:var(--dim)}
  .primary,.secondary,.listen{width:100%;border-radius:10px;border:0;padding:12px;margin-top:16px;font-weight:750;cursor:pointer}
  .worker-error{margin:0 0 8px;padding:8px 12px;border:1px solid #a63a54;border-radius:8px;background:#38141f;color:#ff8da8;font:600 12px ui-monospace,monospace}
  fieldset{border:0;padding:0;margin:0;min-width:0}
  .recording-panel{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}.recording-panel h3{font-size:14px;margin:0 0 8px}.recording-panel p{font-size:12px;color:var(--muted);line-height:1.5}.recording-panel label{display:grid;gap:6px;font-size:12px;color:var(--muted);margin-top:10px}.recording-panel textarea{width:100%;resize:vertical;background:var(--field);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px}.recording-file input{max-width:100%;font-size:12px}.recording-panel [role=alert]{color:#ff8da8}button:disabled{opacity:.45;cursor:default}
  .replay-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
  .replay{border-radius:9px;border:1px solid #2a4a70;background:#122440;color:#cfe3ff;padding:9px;font-size:12px;font-weight:650;cursor:pointer}
  .replay:disabled{opacity:.4;cursor:default}.primary{background:var(--accent);color:#061610}.primary:disabled{opacity:.45}.secondary{background:#1c3656;color:#cfe4ff;border:1px solid #30537b}.listen{background:#172945;color:#cfe3ff;border:1px solid #29476d}.listen.stop{background:#39202a;color:#ffceda;border-color:#713247}
  .badge{font:10px ui-monospace,monospace;text-transform:uppercase;padding:5px 8px;border-radius:99px;background:#17263a;color:var(--dim)}.badge.listening,.badge.signal{color:var(--accent)}.readouts,.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.readouts div,.metrics div{padding:12px;background:#081321;border-radius:10px}.readouts span,.metrics span{display:block;color:var(--dim);font-size:10px}.readouts strong{font:600 12px ui-monospace,monospace}.metrics strong{display:block;font-size:22px;color:#d6e7fb;margin-bottom:3px}
  .mic-settings{display:flex;flex-wrap:wrap;gap:5px 14px;margin-top:10px;color:var(--dim);font:11px ui-monospace,monospace}.mic-settings .on{color:#f5c46b;font-weight:700}
  .receiver-actions{display:flex!important;align-items:center;gap:8px!important}.receiver-actions label{display:flex;align-items:center;gap:5px;color:var(--dim);font:10px ui-monospace,monospace}.receiver-actions select{max-width:150px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--text);font:10px ui-monospace,monospace}
  .detector-head{display:flex;justify-content:space-between;gap:10px;margin:14px 2px 7px;color:var(--muted);font-size:11px;font-weight:650}.detector-head small{color:var(--dim);font-weight:500}
  .sim-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.sim-grid label,.interference{display:grid;gap:8px}.sim-grid select{background:var(--field);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px}.sim-grid input,.interference input{width:100%;accent-color:var(--accent)}output{font:12px ui-monospace,monospace;color:var(--accent)}.switch-row{display:flex;gap:12px;align-items:start;padding:15px;margin-top:18px;border:1px solid var(--line);border-radius:11px}.switch-row input{margin-top:3px;accent-color:var(--accent)}.switch-row b,.switch-row small{display:block}.switch-row b{font-size:13px}.switch-row small{color:var(--dim);margin-top:3px;line-height:1.35}.interference{margin-top:16px}
  .signal-summary{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;margin:-4px 0 20px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#081321;font-size:11px;color:var(--dim)}.signal-summary strong{overflow:hidden;text-overflow:ellipsis;color:var(--muted);white-space:nowrap}.signal-summary .text-button{color:var(--accent)}
  .text-button{font-size:11px}.packet-list{margin-top:14px;border:1px solid var(--line);border-radius:10px;overflow:hidden}.packet-list article{display:grid;grid-template-columns:60px 55px 1fr auto;gap:9px;padding:10px 12px;align-items:center;color:var(--dim);font-size:11px}.packet-mode{color:var(--blue)}code{overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.log{margin-top:12px;max-height:110px;overflow:auto;background:#06101c;padding:8px 12px;border-radius:10px;font:10px/1.5 ui-monospace,monospace;color:#7890ab}.log p{margin:3px 0}.empty{font-style:italic}
  footer{display:flex;justify-content:space-between;gap:20px;max-width:1320px;margin:auto;border-top:1px solid var(--line);padding:20px 24px 32px;color:var(--dim);font-size:11px}
  @media(max-width:850px){.layout{grid-template-columns:1fr}.intro{align-items:start;flex-direction:column}.status-pill{align-self:flex-start}main{padding-top:38px}.app-state>span:not(.dot){display:none}.app-tabs{top:72px}}
  @media(max-width:520px){header{padding:0 15px}main{padding:28px 14px 56px}.card{padding:17px;border-radius:14px}.intro{margin-bottom:24px}.intro h1{font-size:36px}.app-tabs{grid-template-columns:1fr 1fr;top:70px;margin-inline:-2px}.app-tabs button{padding:8px 5px}.receiver .section-head{align-items:flex-start}.receiver-actions{align-items:flex-end;flex-direction:column}.readouts,.metrics{grid-template-columns:1fr 1fr}.sim-grid{grid-template-columns:1fr}.signal-summary{grid-template-columns:1fr auto}.signal-summary>span{display:none}.packet-list article{grid-template-columns:50px 45px 1fr}.packet-list article>:last-child{display:none}footer{padding-inline:15px;flex-direction:column}}
</style>
