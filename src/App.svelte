<script lang="ts">
  import { onMount } from 'svelte';
  import SpectrumDisplay from './lib/components/SpectrumDisplay.svelte';
  import ModeControls from './lib/components/ModeControls.svelte';
  import { AudioEngine } from './lib/audio';
  import { ModemLabWorker, type SimulationResult } from './lib/modem-lab';

  type Mode = 'FSK' | 'CSS' | 'DSSS';

  let spectrum: Float32Array = new Float32Array(1024).fill(-110);
  let receiverState: 'idle' | 'listening' | 'signal' = 'idle';
  let offlineReady = false;
  let installAvailable = false;
  let installPrompt: { prompt: () => Promise<void> } | undefined;
  let audio: AudioEngine;
  let lab: ModemLabWorker;
  let lastResult: SimulationResult | undefined;
  let busy = false;

  let mode: Mode = 'FSK';
  let listening = false;
  let payload = 'SONIC TEST 001';
  let activePanel: 'radio' | 'simulator' = 'radio';
  let settings: Record<Mode, Record<string, number | string | boolean>> = {
    FSK: { centerFrequency: 5000, bandwidth: 2400, tones: 4, symbolRate: 100, pulseShape: 'Gaussian' },
    CSS: { centerFrequency: 8000, bandwidth: 6000, spreadingFactor: 8, chirpDirection: 'Up', preambleSymbols: 8 },
    DSSS: { centerFrequency: 6000, bandwidth: 5000, codeFamily: 'Gold', codeLength: 127, codeIndex: 0, chipRate: 4000 }
  };
  let snr = 10;
  let noiseType = 'White noise';
  let interferer = false;
  let interfererPower = -6;
  let packets = [
    { time: '—', mode: 'Waiting', payload: 'No packets decoded yet', quality: '—' }
  ];
  let logs = ['Ready · Audio engine awaiting user interaction'];

  async function onTransmit(detail: { mode: Mode; payload: string; settings: Record<string, unknown> }) {
    logs = [`${new Date().toLocaleTimeString()} · Queued ${mode} transmission`, ...logs].slice(0, 10);
    busy = true;
    try {
      const waveform = await lab.encode(detail);
      await audio.transmit(waveform.samples);
      logs = [`${new Date().toLocaleTimeString()} · Playing ${waveform.samples.length.toLocaleString()} samples`, ...logs].slice(0, 10);
    } catch (error) {
      logs = [`Transmit error · ${error instanceof Error ? error.message : String(error)}`, ...logs].slice(0, 10);
    } finally { busy = false; }
  }

  async function onListenToggle(next: boolean) {
    try {
      if (next) await audio.startListening(); else audio.stopListening();
      listening = next;
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
  function toggleListen() { void onListenToggle(!listening); }
  function simulate() { void onRunSimulation({ mode, payload, settings: { ...settings[mode] }, snr, interferer, interfererPower }); }
  function onInstall() { void installPrompt?.prompt(); }

  onMount(() => {
    audio = new AudioEngine(); lab = new ModemLabWorker();
    const offSpectrum = audio.onSpectrum(event => { spectrum = event.bins; receiverState = 'signal'; });
    const installHandler = (event: Event) => { event.preventDefault(); installPrompt = event as Event & { prompt: () => Promise<void> }; installAvailable = true; };
    window.addEventListener('beforeinstallprompt', installHandler);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(() => { offlineReady = true; });
    return () => { offSpectrum(); void audio.dispose(); lab.dispose(); window.removeEventListener('beforeinstallprompt', installHandler); };
  });
</script>

<svelte:head><title>Sonic Messaging · Acoustic Modem Test Bed</title><meta name="theme-color" content="#07101d" /></svelte:head>

<header>
  <a class="brand" href={import.meta.env.BASE_URL} aria-label="Sonic Messaging home"><span class="mark">≋</span><span class="brand-copy"><span>Sonic <b>Messaging</b></span><small>v{__APP_VERSION__}</small></span></a>
  <nav aria-label="Workspace"><button class:active={activePanel === 'radio'} on:click={() => activePanel = 'radio'}>Radio</button><button class:active={activePanel === 'simulator'} on:click={() => activePanel = 'simulator'}>Simulator</button></nav>
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
      <div class="tabs" role="tablist" aria-label="Modulation mode">{#each ['FSK','CSS','DSSS'] as item}<button role="tab" aria-selected={mode === item} class:active={mode === item} on:click={() => mode = item as Mode}>{item}<small>{item === 'FSK' ? 'Multi-tone' : item === 'CSS' ? 'Chirp spread' : 'Code spread'}</small></button>{/each}</div>
      <ModeControls {mode} settings={settings[mode]} />
      <label class="payload"><span>Test payload <small>{new TextEncoder().encode(payload).length} bytes</small></span><textarea bind:value={payload} maxlength="256" rows="3"></textarea></label>
      <button class="primary" disabled={!payload || busy} on:click={transmit}><span>▶</span> {busy ? 'Processing…' : 'Transmit test packet'}</button>
    </section>

    <section class="card receiver">
      <div class="section-head"><div><span class="step">02</span><h2>Receiver</h2></div><span class="badge {receiverState}">{receiverState}</span></div>
      <SpectrumDisplay {spectrum} minFrequency={0} maxFrequency={24000} />
      <div class="readouts"><div><span>Peak</span><strong>{spectrum.length ? Math.max(...spectrum).toFixed(1) : '—'} dBFS</strong></div><div><span>Last confidence</span><strong>{lastResult ? `${Math.round(lastResult.confidence * 100)}%` : '—'}</strong></div><div><span>Decoder</span><strong>{listening ? mode : 'Standby'}</strong></div></div>
      <button class:stop={listening} class="listen" on:click={toggleListen}>{listening ? '■ Stop listening' : '◉ Start listening'}</button>
    </section>

    <section class="card simulation">
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
  header { height: 64px; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 max(20px, calc((100vw - 1320px)/2)); background: rgba(6,13,23,.84); backdrop-filter: blur(16px); position: sticky; top:0; z-index:10; }
  .brand { display:flex; align-items:center; gap:10px; color:var(--text); text-decoration:none; font-weight:700; letter-spacing:-.02em; }.brand b{color:var(--accent)}.brand-copy{display:grid;line-height:1.05}.brand-copy small{margin-top:3px;color:var(--dim);font:500 9px/1 ui-monospace,monospace;letter-spacing:.04em}.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:var(--accent);color:#06130f;font-size:25px;font-weight:900}
  nav { display:flex; gap:4px; padding:4px; border:1px solid var(--line); border-radius:10px; } nav button,.install,.text-button{border:0;background:transparent;color:var(--muted);cursor:pointer} nav button{padding:6px 14px;border-radius:7px;font-size:13px} nav button.active{background:#17263a;color:var(--text)}
  .app-state{justify-self:end;display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:#f5b84b}.dot.ready{background:var(--accent)}.install{color:var(--accent);margin-left:8px}
  main { max-width:1320px; margin:auto; padding:56px 24px 72px; }.intro{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:34px}.eyebrow{color:var(--accent)!important;font:700 11px ui-monospace,monospace;letter-spacing:.18em}.intro h1{font-size:clamp(34px,5vw,58px);line-height:1.04;letter-spacing:-.045em;margin:8px 0 15px}.intro h1 em{font-style:normal;color:#84b9ff}.intro p{color:var(--muted);max-width:680px;line-height:1.6;margin:0}.status-pill{display:flex;align-items:center;gap:9px;border:1px solid var(--line);padding:9px 12px;border-radius:99px;color:var(--muted);font-size:12px;white-space:nowrap}.status-pill span{width:8px;height:8px;border-radius:50%;background:#506078}.status-pill span.live{background:var(--accent);box-shadow:0 0 0 4px #4ee8b422}
  .layout{display:grid;grid-template-columns:1.05fr .95fr;gap:18px;align-items:start}.card{background:linear-gradient(145deg,rgba(15,29,48,.94),rgba(8,18,31,.96));border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 40px #0003}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.section-head>div{display:flex;align-items:center;gap:10px}.section-head h2{font-size:16px;margin:0}.step{font:11px ui-monospace,monospace;color:var(--accent);border:1px solid #4ee8b444;border-radius:6px;padding:4px}.hint{font-size:11px;color:var(--dim)}
  .tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:5px;background:#07111e;border-radius:12px;margin-bottom:24px}.tabs button{border:1px solid transparent;border-radius:9px;padding:9px;background:transparent;color:var(--muted);font-weight:750;cursor:pointer}.tabs button small{display:block;font-size:10px;font-weight:500;color:var(--dim);margin-top:2px}.tabs button.active{border-color:#375272;background:#152740;color:var(--text)}.tabs button.active small{color:#9eb3cc}
  .payload{display:grid;gap:8px;margin-top:22px}.payload>span,.sim-grid label>span,.interference>span{display:flex;justify-content:space-between;color:var(--muted);font-size:13px;font-weight:650}.payload textarea{resize:vertical;color:var(--text);background:var(--field);border:1px solid var(--line);border-radius:10px;padding:12px}.payload small{color:var(--dim)}
  .primary,.secondary,.listen{width:100%;border-radius:10px;border:0;padding:12px;margin-top:16px;font-weight:750;cursor:pointer}.primary{background:var(--accent);color:#061610}.primary:disabled{opacity:.45}.secondary{background:#1c3656;color:#cfe4ff;border:1px solid #30537b}.listen{background:#172945;color:#cfe3ff;border:1px solid #29476d}.listen.stop{background:#39202a;color:#ffceda;border-color:#713247}
  .badge{font:10px ui-monospace,monospace;text-transform:uppercase;padding:5px 8px;border-radius:99px;background:#17263a;color:var(--dim)}.badge.listening,.badge.signal{color:var(--accent)}.readouts,.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.readouts div,.metrics div{padding:12px;background:#081321;border-radius:10px}.readouts span,.metrics span{display:block;color:var(--dim);font-size:10px}.readouts strong{font:600 12px ui-monospace,monospace}.metrics strong{display:block;font-size:22px;color:#d6e7fb;margin-bottom:3px}
  .sim-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.sim-grid label,.interference{display:grid;gap:8px}.sim-grid select{background:var(--field);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px}.sim-grid input,.interference input{width:100%;accent-color:var(--accent)}output{font:12px ui-monospace,monospace;color:var(--accent)}.switch-row{display:flex;gap:12px;align-items:start;padding:15px;margin-top:18px;border:1px solid var(--line);border-radius:11px}.switch-row input{margin-top:3px;accent-color:var(--accent)}.switch-row b,.switch-row small{display:block}.switch-row b{font-size:13px}.switch-row small{color:var(--dim);margin-top:3px;line-height:1.35}.interference{margin-top:16px}
  .text-button{font-size:11px}.packet-list{margin-top:14px;border:1px solid var(--line);border-radius:10px;overflow:hidden}.packet-list article{display:grid;grid-template-columns:60px 55px 1fr auto;gap:9px;padding:10px 12px;align-items:center;color:var(--dim);font-size:11px}.packet-mode{color:var(--blue)}code{overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.log{margin-top:12px;max-height:110px;overflow:auto;background:#06101c;padding:8px 12px;border-radius:10px;font:10px/1.5 ui-monospace,monospace;color:#7890ab}.log p{margin:3px 0}.empty{font-style:italic}
  footer{display:flex;justify-content:space-between;gap:20px;max-width:1320px;margin:auto;border-top:1px solid var(--line);padding:20px 24px 32px;color:var(--dim);font-size:11px}
  @media(max-width:850px){header{grid-template-columns:1fr auto}header nav{display:none}.layout{grid-template-columns:1fr}.intro{align-items:start;flex-direction:column}.status-pill{align-self:flex-start}main{padding-top:38px}.app-state>span:not(.dot){display:none}}
  @media(max-width:520px){header{padding:0 15px}main{padding:28px 14px 56px}.card{padding:17px;border-radius:14px}.intro h1{font-size:36px}.readouts,.metrics{grid-template-columns:1fr 1fr}.sim-grid{grid-template-columns:1fr}.packet-list article{grid-template-columns:50px 45px 1fr}.packet-list article>:last-child{display:none}footer{padding-inline:15px;flex-direction:column}}
</style>
