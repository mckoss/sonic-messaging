<script lang="ts">
  import { onMount } from 'svelte';
  import SpectrumDisplay from './lib/components/SpectrumDisplay.svelte';
  import SymbolWaterfall from './lib/components/SymbolWaterfall.svelte';
  import ModeControls from './lib/components/ModeControls.svelte';
  import { AudioEngine } from './lib/audio';
  import { ModemLabWorker, type SimulationResult } from './lib/modem-lab';
  import { fskFrequencies } from './lib/dsp';
  import { loadUserPreferences, saveUserPreferences, type Mode, type UserPreferences } from './lib/preferences';
  import { WATERFALL_SPEED_SAMPLES } from './lib/audio/waterfall';
  import { replayPlaybackPosition, waterfallScrubSamples, waterfallView } from './lib/audio/scrub-store';
  import { get } from 'svelte/store';

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
  let workerError = '';
  let receivedMarkerId = 0;
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
  let scrollSpeed: 'Slow' | 'Medium' | 'Fast' = 'Medium';
  let inputDeviceId = 'default';
  let inputDevices: Array<{ deviceId: string; label: string }> = [];
  let packets = [
    { time: '—', mode: 'Waiting', payload: 'No packets decoded yet', quality: '—' }
  ];
  let logs = ['Ready · Audio engine awaiting user interaction'];

  async function onTransmit(detail: { mode: Mode; payload: string; settings: Record<string, unknown> }) {
    busy = true;
    try {
      const waveform = await lab.encode(detail);
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
        try { await audio.startListening(inputDeviceId); }
        catch (error) {
          if (inputDeviceId === 'default') throw error;
          logs = [`Saved microphone unavailable · using system default`, ...logs].slice(0, 10);
          inputDeviceId = 'default'; persistPreferences(); await audio.startListening();
        }
      } else {
        audio.stopListening(); audio.disableDetector();
        // Abandon any packet mid-read: the worker's decoder is reset by the
        // detector reconfigure, so the RX lane must not keep the partial text.
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
    return { mode, settings, snr, noiseType, interferer, interfererPower, scrollSpeed, inputDeviceId, payload };
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

  onMount(() => {
    const restored = loadUserPreferences(window.localStorage, currentPreferences());
    mode = restored.mode; settings = restored.settings; snr = restored.snr; noiseType = restored.noiseType;
    interferer = restored.interferer; interfererPower = restored.interfererPower;
    scrollSpeed = restored.scrollSpeed; inputDeviceId = restored.inputDeviceId; payload = restored.payload;
    preferencesReady = true;
    audio = new AudioEngine(); lab = new ModemLabWorker();
    void refreshInputDevices(false);
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
      const decoded = new TextDecoder('utf-8', { fatal: true });
      try {
        const text = decoded.decode(event.payload);
        packets = [{ time: new Date().toLocaleTimeString(), mode: event.mode, payload: text,
          quality: `${Math.round(event.confidence * 100)}%` }, ...packets.filter(p => p.mode !== 'Waiting')].slice(0, 6);
      } catch {
        logs = [`${new Date().toLocaleTimeString()} · RX FSK frame with valid CRC rejected: payload is not UTF-8 text`, ...logs].slice(0, 10);
      }
    });
    const offReception = audio.onReception(event => {
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
        addMarker(`LEN ${event.length ?? '?'}`, 2);
      } else if (event.token === 'crc-confirm') {
        receivedMessages = [...receivedMessages, `${receivingMessage} ✓`].slice(-24); receivingMessage = '';
        addMarker('✓', 2);
      } else if (event.token === 'crc-error') {
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
      logs = [`${new Date().toLocaleTimeString()} · ⚠ Capture dropouts · ${ms} ms of zeroed audio — OS/browser pipeline glitch`, ...logs].slice(0, 10);
    });
    const installHandler = (event: Event) => { event.preventDefault(); installPrompt = event as Event & { prompt: () => Promise<void> }; installAvailable = true; };
    window.addEventListener('beforeinstallprompt', installHandler);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(() => { offlineReady = true; });
    return () => { offHealth(); offSpectrum(); offSymbols(); offPackets(); offReception(); offCaptureGaps(); void audio.dispose(); lab.dispose(); window.removeEventListener('beforeinstallprompt', installHandler); };
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
  <section class="intro"><div><p class="eyebrow">ACOUSTIC MODEM WORKBENCH</p><h1>Shape signals. Test channels.<br /><em>Hear what survives.</em></h1><p>Explore modulation, coding, and multi-user rejection across real and simulated acoustic channels.</p></div><div class="status-pill"><span class:live={listening || receiverState !== 'idle'}></span>{listening ? 'Microphone live' : 'Audio idle'}</div></section>

  <div class="layout">
    <section class="card composer">
      <div class="section-head"><div><span class="step">01</span><h2>Signal composer</h2></div><span class="hint">48 kHz pipeline</span></div>
      <div class="tabs" role="tablist" aria-label="Modulation mode">{#each ['FSK','CSS','DSSS'] as item}<button role="tab" aria-selected={mode === item} class:active={mode === item} on:click={() => selectMode(item as Mode)}>{item}<small>{item === 'FSK' ? 'Multi-tone' : item === 'CSS' ? 'Chirp spread' : 'Code spread'}</small></button>{/each}</div>
      <div on:change={onSettingsChange}><ModeControls {mode} settings={settings[mode]} /></div>
      <label class="payload"><span>Test payload <small>{new TextEncoder().encode(payload).length} bytes</small></span><textarea bind:value={payload} maxlength="256" rows="3" on:input={persistPreferences}></textarea></label>
      <button class="primary" disabled={!payload || busy} on:click={transmit}><span>▶</span> {busy ? 'Processing…' : 'Transmit test packet'}</button>
    </section>

    <section class="card receiver">
      <div class="section-head"><div><span class="step">02</span><h2>Receiver</h2></div><div class="receiver-actions"><label>Mic <select bind:value={inputDeviceId} on:change={onInputDeviceChange} aria-label="Microphone"><option value="default">System default</option>{#each inputDevices as device}<option value={device.deviceId}>{device.label}</option>{/each}</select></label><label>Scroll <select bind:value={scrollSpeed} on:change={persistPreferences} aria-label="Waterfall scroll speed"><option>Slow</option><option>Medium</option><option>Fast</option></select></label><span class="badge {receiverState}">{receiverState}</span></div></div>
      {#if workerError}<div class="worker-error" role="alert" data-testid="worker-error">⚠ Receiver stalled · {workerError}</div>{/if}
      <SpectrumDisplay {spectrum} sequence={spectrumSequence} samplePosition={spectrumSamplePosition} live={listening}
        samplesPerCssPixel={WATERFALL_SPEED_SAMPLES[scrollSpeed]} minFrequency={spectrumMin} maxFrequency={spectrumMax} />
      {#if mode === 'FSK'}
        <div class="detector-head"><span>FSK symbol likelihood</span><small>Sync acquisition + CRC packet decoding</small></div>
        <SymbolWaterfall scores={symbolScores} sequence={symbolSequence} live={listening}
          messages={receivedMessages} currentMessage={receivingMessage} markers={receivedMarkers} confidence={symbolConfidence}
          samplePosition={symbolSamplePosition} samplesPerCssPixel={WATERFALL_SPEED_SAMPLES[scrollSpeed]}
          sampleRate={audio?.state.sampleRate ?? 48_000}
          symbolRate={Number(settings.FSK.symbolRate)}
          labels={fskFrequencies(Number(settings.FSK.lowestFrequency), Number(settings.FSK.toneSpacing), Number(settings.FSK.tones)).map((frequency, index) => `S${index} · ${frequency}Hz`)} />
      {/if}
      <div class="readouts"><div><span>{mode === 'FSK' && listening ? 'Window power' : 'Peak'}</span><strong>{mode === 'FSK' && listening ? symbolPower.toFixed(1) : spectrum.length ? Math.max(...spectrum).toFixed(1) : '—'} dBFS</strong></div><div><span>{mode === 'FSK' && listening ? 'Symbol confidence' : 'Last confidence'}</span><strong>{mode === 'FSK' && listening ? `${Math.round(symbolConfidence * 100)}%` : lastResult ? `${Math.round(lastResult.confidence * 100)}%` : '—'}</strong></div><div><span>Decoder</span><strong>{listening ? mode === 'FSK' ? rawSymbol >= 0 ? `FSK · S${rawSymbol}` : 'FSK · noise' : mode : 'Standby'}</strong></div></div>
      {#if listening && micSettings}
        <div class="mic-settings" data-testid="mic-settings">
          <span>Mic{micSettings.sampleRate ? ` · ${(micSettings.sampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz` : ''}</span>
          {#each MIC_PROCESSING as stage}
            <span class:on={micSettings[stage.key] === true}>{micSettings[stage.key] === undefined ? `${stage.label} ?` : micSettings[stage.key] ? `⚠ ${stage.label} ON` : `${stage.label} off`}</span>
          {/each}
        </div>
      {/if}
      <button class:stop={listening} class="listen" on:click={toggleListen}>{listening ? '■ Stop listening' : '◉ Start listening'}</button>
      <div class="replay-row"><button class="replay" disabled={busy} on:click={() => void replayVisible('raw')}>▶ Replay visible audio</button><button class="replay" disabled={busy} on:click={() => void replayVisible('fft')}>▶ Replay FFT view</button></div>
    </section>

    <section class="card simulation" on:change={persistPreferences}>
      <div class="section-head"><div><span class="step">03</span><h2>Channel simulation</h2></div><span class="hint">Worker isolated</span></div>
      <div class="sim-grid"><label><span>SNR <output>{snr} dB</output></span><input type="range" min="-30" max="40" bind:value={snr} /></label><label><span>Noise model</span><select bind:value={noiseType}><option>White noise</option><option>Pink noise</option><option>Impulse noise</option><option>Room response</option></select></label></div>
      <label class="switch-row"><input type="checkbox" bind:checked={interferer} /><span><b>Competing transmitter</b><small>Add an overlapping user with a different code or packet.</small></span></label>
      {#if interferer}<label class="interference"><span>Interferer relative power <output>{interfererPower} dB</output></span><input type="range" min="-30" max="20" bind:value={interfererPower} /></label>{/if}
      <button class="secondary" disabled={busy} on:click={simulate}>{busy ? 'Running…' : 'Run encode → channel → decode'}</button>
    </section>

    <section class="card results">
      <div class="section-head"><div><span class="step">04</span><h2>Results</h2></div><button class="text-button" on:click={() => logs = []}>Clear log</button></div>
      <div class="metrics"><div><strong>{lastResult ? (lastResult.ok ? '0%' : '100%') : '—'}</strong><span>Packet error</span></div><div><strong>{lastResult?.userScores ? lastResult.userScores[0]?.index ?? '—' : '—'}</strong><span>Top DSSS user</span></div><div><strong>{lastResult ? `${lastResult.elapsedMs.toFixed(1)}ms` : '—'}</strong><span>Decode time</span></div></div>
      <div class="packet-list" aria-live="polite">{#each packets as packet}<article><time>{packet.time}</time><span class="packet-mode">{packet.mode}</span><code>{packet.payload}</code><span>{packet.quality}</span></article>{/each}</div>
      <div class="log">{#each logs as entry}<p>{entry}</p>{:else}<p class="empty">Log cleared</p>{/each}</div>
    </section>
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
  .layout{display:grid;grid-template-columns:1.05fr .95fr;gap:18px;align-items:start}.card{background:linear-gradient(145deg,rgba(15,29,48,.94),rgba(8,18,31,.96));border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 40px #0003}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.section-head>div{display:flex;align-items:center;gap:10px}.section-head h2{font-size:16px;margin:0}.step{font:11px ui-monospace,monospace;color:var(--accent);border:1px solid #4ee8b444;border-radius:6px;padding:4px}.hint{font-size:11px;color:var(--dim)}
  .tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:5px;background:#07111e;border-radius:12px;margin-bottom:24px}.tabs button{border:1px solid transparent;border-radius:9px;padding:9px;background:transparent;color:var(--muted);font-weight:750;cursor:pointer}.tabs button small{display:block;font-size:10px;font-weight:500;color:var(--dim);margin-top:2px}.tabs button.active{border-color:#375272;background:#152740;color:var(--text)}.tabs button.active small{color:#9eb3cc}
  .payload{display:grid;gap:8px;margin-top:22px}.payload>span,.sim-grid label>span,.interference>span{display:flex;justify-content:space-between;color:var(--muted);font-size:13px;font-weight:650}.payload textarea{resize:vertical;color:var(--text);background:var(--field);border:1px solid var(--line);border-radius:10px;padding:12px}.payload small{color:var(--dim)}
  .primary,.secondary,.listen{width:100%;border-radius:10px;border:0;padding:12px;margin-top:16px;font-weight:750;cursor:pointer}
  .worker-error{margin:0 0 8px;padding:8px 12px;border:1px solid #a63a54;border-radius:8px;background:#38141f;color:#ff8da8;font:600 12px ui-monospace,monospace}
  .replay-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
  .replay{border-radius:9px;border:1px solid #2a4a70;background:#122440;color:#cfe3ff;padding:9px;font-size:12px;font-weight:650;cursor:pointer}
  .replay:disabled{opacity:.4;cursor:default}.primary{background:var(--accent);color:#061610}.primary:disabled{opacity:.45}.secondary{background:#1c3656;color:#cfe4ff;border:1px solid #30537b}.listen{background:#172945;color:#cfe3ff;border:1px solid #29476d}.listen.stop{background:#39202a;color:#ffceda;border-color:#713247}
  .badge{font:10px ui-monospace,monospace;text-transform:uppercase;padding:5px 8px;border-radius:99px;background:#17263a;color:var(--dim)}.badge.listening,.badge.signal{color:var(--accent)}.readouts,.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.readouts div,.metrics div{padding:12px;background:#081321;border-radius:10px}.readouts span,.metrics span{display:block;color:var(--dim);font-size:10px}.readouts strong{font:600 12px ui-monospace,monospace}.metrics strong{display:block;font-size:22px;color:#d6e7fb;margin-bottom:3px}
  .mic-settings{display:flex;flex-wrap:wrap;gap:5px 14px;margin-top:10px;color:var(--dim);font:11px ui-monospace,monospace}.mic-settings .on{color:#f5c46b;font-weight:700}
  .receiver-actions{display:flex!important;align-items:center;gap:8px!important}.receiver-actions label{display:flex;align-items:center;gap:5px;color:var(--dim);font:10px ui-monospace,monospace}.receiver-actions select{max-width:150px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--text);font:10px ui-monospace,monospace}
  .detector-head{display:flex;justify-content:space-between;gap:10px;margin:14px 2px 7px;color:var(--muted);font-size:11px;font-weight:650}.detector-head small{color:var(--dim);font-weight:500}
  .sim-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.sim-grid label,.interference{display:grid;gap:8px}.sim-grid select{background:var(--field);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px}.sim-grid input,.interference input{width:100%;accent-color:var(--accent)}output{font:12px ui-monospace,monospace;color:var(--accent)}.switch-row{display:flex;gap:12px;align-items:start;padding:15px;margin-top:18px;border:1px solid var(--line);border-radius:11px}.switch-row input{margin-top:3px;accent-color:var(--accent)}.switch-row b,.switch-row small{display:block}.switch-row b{font-size:13px}.switch-row small{color:var(--dim);margin-top:3px;line-height:1.35}.interference{margin-top:16px}
  .text-button{font-size:11px}.packet-list{margin-top:14px;border:1px solid var(--line);border-radius:10px;overflow:hidden}.packet-list article{display:grid;grid-template-columns:60px 55px 1fr auto;gap:9px;padding:10px 12px;align-items:center;color:var(--dim);font-size:11px}.packet-mode{color:var(--blue)}code{overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.log{margin-top:12px;max-height:110px;overflow:auto;background:#06101c;padding:8px 12px;border-radius:10px;font:10px/1.5 ui-monospace,monospace;color:#7890ab}.log p{margin:3px 0}.empty{font-style:italic}
  footer{display:flex;justify-content:space-between;gap:20px;max-width:1320px;margin:auto;border-top:1px solid var(--line);padding:20px 24px 32px;color:var(--dim);font-size:11px}
  @media(max-width:850px){.layout{grid-template-columns:1fr}.intro{align-items:start;flex-direction:column}.status-pill{align-self:flex-start}main{padding-top:38px}.app-state>span:not(.dot){display:none}}
  @media(max-width:520px){header{padding:0 15px}main{padding:28px 14px 56px}.card{padding:17px;border-radius:14px}.intro h1{font-size:36px}.receiver .section-head{align-items:flex-start}.receiver-actions{align-items:flex-end;flex-direction:column}.readouts,.metrics{grid-template-columns:1fr 1fr}.sim-grid{grid-template-columns:1fr}.packet-list article{grid-template-columns:50px 45px 1fr}.packet-list article>:last-child{display:none}footer{padding-inline:15px;flex-direction:column}}
</style>
