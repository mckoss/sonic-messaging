<script lang="ts">
  import { onMount } from 'svelte';
  import { AudioEngine } from '../audio';
  import { ModemLabWorker } from '../modem-lab';
  import { RecordingCapture, encodeRecording, decodeRecording, MAX_RECORDING_BYTES, type Recording } from '../audio/recording';
  import { defaultPlan, validatePlan, planId, experimentTimeline, CHECKPOINT_FSK, applyTransmitterLog, validateTransmitterLog,
    type ExperimentPlan, type ExperimentReport, type TransmitterLog } from '../experiment';

  export let active = false;
  export let unavailable = false;
  export let inputDeviceId = 'default';
  export let beforeStart: () => Promise<void>;
  let engine: AudioEngine, lab: ModemLabWorker;
  let plan = defaultPlan();
  let report: ExperimentReport | undefined;
  let transmitterLog: TransmitterLog | undefined;
  let recording: Recording | undefined;
  let capture: RecordingCapture | undefined;
  let role: 'idle' | 'transmitting' | 'receiving' | 'replaying' = 'idle';
  let status = 'Load the same plan on both devices. Start the receiver first, then the transmitter.';
  let error = '', notes = '', seconds = 0;
  let finalizing = false, cancelled = false;
  $: duration = (experimentTimeline(plan, 48000).slice(-1)[0]?.end ?? 0) / 48000;
  $: rows = report ? applyTransmitterLog(report, plan, transmitterLog) : [];
  $: measured = rows.filter(r => r.status === 'measured');
  $: recovered = measured.filter(r => r.messageOk).length;
  $: compared = measured.reduce((sum, r) => sum + (r.comparedBits ?? 0), 0);
  $: bitErrors = measured.reduce((sum, r) => sum + (r.bitErrors ?? 0), 0);
  $: groups = [...new Set(plan.trials.map(t => JSON.stringify(t)))].map(key => {
    const trials = measured.filter(r => JSON.stringify(plan.trials[r.index]) === key);
    const settings = JSON.parse(key) as ExperimentPlan['trials'][number];
    const bits = trials.reduce((s, r) => s + (r.comparedBits ?? 0), 0);
    const errors = trials.reduce((s, r) => s + (r.bitErrors ?? 0), 0);
    return { settings, count: trials.length, success: trials.filter(r => r.messageOk).length, bits, errors };
  });
  function changed() { plan = plan; report = undefined; recording = undefined; transmitterLog = undefined; error = ''; }
  function download(name: string, data: BlobPart, type: string) {
    const url = URL.createObjectURL(new Blob([data], { type })), link = document.createElement('a');
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportPlan() {
    try { plan = validatePlan(plan); download('sonic-experiment.json', JSON.stringify(plan, null, 2), 'application/json'); }
    catch (e) { error = String(e); }
  }
  async function loadFile(event: Event, kind: 'plan' | 'recording' | 'log') {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    active = true; error = '';
    try {
      if (file.size > (kind === 'recording' ? MAX_RECORDING_BYTES : 65536)) throw new Error('File is too large');
      if (kind === 'recording') {
        const loaded = decodeRecording(await file.arrayBuffer());
        if (!loaded.metadata.experiment) throw new Error('This WAV has no shared experiment schedule');
        plan = validatePlan(loaded.metadata.experiment.plan); recording = loaded; report = undefined;
        transmitterLog = loaded.metadata.experiment.transmitterLog; notes = loaded.metadata.notes;
        status = 'Experiment recording loaded. Replay to calculate results from the original samples.';
      } else if (kind === 'plan') {
        plan = validatePlan(JSON.parse(await file.text())); changed(); status = 'Shared plan loaded.';
      } else {
        transmitterLog = validateTransmitterLog(JSON.parse(await file.text()), plan);
        if (recording?.metadata.experiment) recording.metadata.experiment.transmitterLog = transmitterLog;
        status = 'Transmitter log applied; trials not fully sent are excluded.';
      }
    } catch (e) { error = String(e); }
    finally { input.value = ''; active = false; }
  }
  async function startTransmit() {
    error = ''; active = true; cancelled = false; role = 'transmitting'; seconds = 0;
    try {
      plan = validatePlan(plan); report = undefined; transmitterLog = undefined; recording = undefined;
      await beforeStart(); await engine.start();
      const sampleRate = engine.state.sampleRate!;
      transmitterLog = { format: 'sonic-transmission', version: 1, planId: planId(plan), sampleRate,
        playedSamples: 0, completed: false, appVersion: __APP_VERSION__ };
      status = 'Preparing the complete transmission schedule…';
      const waveform = await lab.encodeExperiment(plan, sampleRate);
      if (cancelled) { status = 'Transmission cancelled before playback; no trials were sent.'; return; }
      status = 'Transmitting scheduled checkpoints and trials…';
      await engine.transmit(waveform.samples);
      await engine.waitForPlayback();
      const playedSamples = engine.state.playbackSamples ?? 0;
      transmitterLog = { format: 'sonic-transmission', version: 1, planId: planId(plan), sampleRate,
        playedSamples, completed: playedSamples === waveform.samples.length, appVersion: __APP_VERSION__ };
      status = transmitterLog.completed ? 'Transmission complete. Save the transmitter log for the receiver.' : 'Transmission interrupted. Save the log to exclude unfinished trials.';
    } catch (e) { error = String(e); }
    finally { role = 'idle'; active = false; }
  }
  async function startReceive() {
    error = ''; active = true; role = 'receiving'; cancelled = false; seconds = 0;
    try {
      plan = validatePlan(plan); report = undefined; recording = undefined; transmitterLog = undefined;
      await beforeStart(); await engine.startListening(inputDeviceId);
      if (cancelled) { engine.stopListening(); role = 'idle'; active = false; return; }
      capture = new RecordingCapture({ format: 'sonic-recording', version: 1, createdAt: new Date().toISOString(),
        appVersion: __APP_VERSION__, sampleRate: engine.state.sampleRate!, inputSettings: { ...engine.state.inputSettings },
        fsk: CHECKPOINT_FSK, userAgent: navigator.userAgent, notes, experiment: { plan } });
      engine.configureExperiment(plan, engine.state.sampleRate!);
      status = 'Recording; waiting for a matching schedule checkpoint. Start the other device now.';
    } catch (e) { engine.stopListening(); role = 'idle'; active = false; error = String(e); }
  }
  async function stopReceive() {
    if (finalizing || !capture) return;
    finalizing = true; engine.stopListening();
    recording = capture.finish(); capture = undefined;
    try {
      report = await engine.finishExperiment();
      recording.metadata.experiment!.report = report;
      status = report.captureLoss ? 'Live decoding lost samples. Save and replay the full recording for valid results.'
        : report.complete ? 'Experiment received. Save the WAV and results.' : 'Capture stopped; unfinished or unsynchronized trials are not scored.';
    } catch (e) { error = String(e); }
    finally { role = 'idle'; active = false; finalizing = false; }
  }
  async function replay() {
    if (!recording) return;
    active = true; role = 'replaying'; cancelled = false; error = ''; report = undefined; seconds = 0;
    try {
      await beforeStart(); status = 'Replaying the shared schedule from recorded samples…';
      await engine.replayRecording(recording, CHECKPOINT_FSK, progress => seconds = progress);
      if (!cancelled && report) recording.metadata.experiment!.report = report;
      status = cancelled ? 'Replay stopped; partial results only.' : 'Experiment replay complete.';
    } catch (e) { error = String(e); }
    finally { role = 'idle'; active = false; }
  }
  async function stop() {
    cancelled = true;
    try {
      if (role === 'receiving') await stopReceive();
      else if (role === 'transmitting') await engine.stopTransmissionPrecisely();
      else if (role === 'replaying') engine.stopReplay();
    } catch (e) { error = String(e); }
  }
  function saveResults() {
    if (!report) return;
    download('sonic-experiment-results.json', JSON.stringify({ plan, receiverVersion: __APP_VERSION__,
      recordingCreatedAt: recording?.metadata.createdAt, report, scoredResults: rows, transmitterLog }, null, 2), 'application/json');
  }
  onMount(() => {
    engine = new AudioEngine(); lab = new ModemLabWorker();
    const offState = engine.onState(state => { if (role === 'transmitting') seconds = (state.playbackSamples ?? 0) / (state.sampleRate ?? 48000); });
    const offReport = engine.onExperiment(value => {
      report = value;
      if (role === 'receiving') {
        status = value.captureLoss ? 'Live decoder overloaded. Recording continues; replay will recover the original timing.'
          : `Synchronized at ${value.checkpoints.length} checkpoints; ${value.results.filter(r => r.status === 'measured').length}/${plan.trials.length} trials measured.`;
        if (value.complete) void stopReceive();
      }
    });
    const offCapture = engine.onCapture(event => {
      if (!capture) return;
      try {
        const full = capture.append(event.samples, event.sampleRate, event.sequence);
        seconds = Math.floor(capture.seconds * 10) / 10;
        if (full) void stopReceive();
      } catch (e) { error = String(e); void stopReceive(); }
    });
    const offHealth = engine.onWorkerHealth(value => {
      if (!value.healthy) error = value.reason ?? 'Experiment worker unavailable';
    });
    return () => { offHealth(); offState(); offReport(); offCapture(); void engine.dispose(); lab.dispose(); };
  });
</script>

<section class="experiment" aria-label="Shared-schedule experiment">
  <h2>Shared-schedule FSK experiment</h2>
  <p>Share one plan between two devices. Each trial sends a checkpoint, a quiet guard interval, and known test data. Payload correction: none (baseline).</p>
  <fieldset disabled={active || unavailable}>
    <div class="controls">
      <label>Payload bytes <input type="number" min="1" max="128" bind:value={plan.payloadBytes} on:change={changed} /></label>
      <label>Data seed <input type="number" min="0" max="4294967295" bind:value={plan.seed} on:change={changed} /></label>
      <label>Quiet guard (seconds) <input type="number" min="0.25" max="2" step="0.25" bind:value={plan.guardSeconds} on:change={changed} /></label>
    </div>
    <div class="scroll"><table><caption>Transmission schedule · approximately {Number.isFinite(duration) ? duration.toFixed(1) : '—'} seconds</caption>
      <thead><tr><th>Trial</th><th>Tones</th><th>Baud</th><th>Lowest Hz</th><th>Spacing Hz</th><th>Amplitude</th><th></th></tr></thead>
      <tbody>{#each plan.trials as trial, i}<tr><td>{i + 1}</td>
        <td><select aria-label={`Trial ${i + 1} tones`} bind:value={trial.tones} on:change={changed}>{#each [2,4,8,16] as count}<option value={count}>{count}</option>{/each}</select></td>
        <td><input aria-label={`Trial ${i + 1} baud`} type="number" min="10" max="1000" bind:value={trial.symbolRate} on:change={changed} /></td>
        <td><input aria-label={`Trial ${i + 1} lowest frequency`} type="number" min="100" max="20000" bind:value={trial.lowestFrequency} on:change={changed} /></td>
        <td><input aria-label={`Trial ${i + 1} spacing`} type="number" min="10" bind:value={trial.spacing} on:change={changed} /></td>
        <td><input aria-label={`Trial ${i + 1} amplitude`} type="number" min="0.01" max="1" step="0.1" bind:value={trial.amplitude} on:change={changed} /></td>
        <td><button aria-label={`Remove trial ${i + 1}`} disabled={plan.trials.length === 1} on:click={() => { plan.trials = plan.trials.filter((_, j) => j !== i); changed(); }}>×</button></td>
      </tr>{/each}</tbody></table></div>
    <div class="actions"><button disabled={plan.trials.length >= 32} on:click={() => { plan.trials = [...plan.trials, { ...plan.trials.slice(-1)[0]! }]; changed(); }}>Add trial</button><button on:click={exportPlan}>Save shared plan</button><label>Load shared plan <input type="file" accept=".json" on:change={e => loadFile(e, 'plan')} /></label></div>
    <label>Experiment notes <textarea rows="2" maxlength="4000" bind:value={notes} placeholder="Devices, distance, orientation, volume, background noise"></textarea></label>
    <div class="actions"><button on:click={startReceive}>Start experiment receiver</button><button on:click={startTransmit}>Transmit experiment</button><label>Load experiment WAV <input type="file" accept=".wav" on:change={e => loadFile(e, 'recording')} /></label></div>
  </fieldset>
  {#if active && role !== 'idle'}<button disabled={finalizing} on:click={stop}>Stop experiment</button>{/if}
  <p role="status" data-testid="experiment-status">{status} {active ? `${seconds.toFixed(1)} s` : ''}</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="actions">
    {#if recording}<button disabled={active || unavailable} on:click={() => download('sonic-experiment.wav', encodeRecording(recording!), 'audio/wav')}>Save experiment WAV</button><button disabled={active || unavailable} on:click={replay}>Replay experiment</button>{/if}
    {#if transmitterLog}<button disabled={active} on:click={() => download('sonic-transmitter-log.json', JSON.stringify(transmitterLog, null, 2), 'application/json')}>Save transmitter log</button>{/if}
    {#if report}<button disabled={active} on:click={saveResults}>Save experiment results</button><label>Load transmitter log <input type="file" accept=".json" disabled={active} on:change={e => loadFile(e, 'log')} /></label>{/if}
  </div>
  {#if report}
    <p data-testid="experiment-summary">{recovered}/{measured.length} exact messages · {compared ? `${bitErrors}/${compared} raw bit errors (${(100 * bitErrors / compared).toFixed(3)}%)` : 'Raw BER unavailable'} · {report.checkpoints.length} checkpoints</p>
    <p>{report.captureLoss ? 'Live results invalid after capture loss; replay the saved WAV.' : transmitterLog ? 'Only fully transmitted trials are scored.' : 'Delivery counts assume the transmitter completed the schedule. Import its log to exclude unsent or interrupted trials.'} Unacquired packets count as message failures; their raw BER is unavailable. Raw bits include sync, protected length, payload and CRC before correction.</p>
    <div class="scroll"><table data-testid="experiment-results"><thead><tr><th>Trial</th><th>FSK / baud</th><th>Status</th><th>Acquired</th><th>Raw errors / bits</th><th>CRC</th><th>Exact message</th><th>Payload FEC</th></tr></thead>
      <tbody>{#each rows as row}<tr><td>{row.index + 1}</td><td>{plan.trials[row.index].tones} / {plan.trials[row.index].symbolRate}</td><td>{row.status}</td><td>{row.acquired === undefined ? '—' : row.acquired ? 'yes' : 'no'}</td><td>{row.comparedBits ? `${row.bitErrors}/${row.comparedBits}` : 'N/A'}</td><td>{row.crcOk === undefined ? '—' : row.crcOk ? 'pass' : 'fail'}</td><td>{row.messageOk === undefined ? '—' : row.messageOk ? 'pass' : 'fail'}</td><td>none</td></tr>{/each}</tbody></table></div>
    <div class="scroll"><table><caption>By configuration</caption><thead><tr><th>FSK / baud / Hz / spacing / amplitude</th><th>Message recovery</th><th>Raw BER</th></tr></thead><tbody>{#each groups as g}<tr><td>{g.settings.tones} / {g.settings.symbolRate} / {g.settings.lowestFrequency} / {g.settings.spacing} / {g.settings.amplitude}</td><td>{g.success}/{g.count}</td><td>{g.bits ? `${(100 * g.errors / g.bits).toFixed(3)}%` : 'N/A'}</td></tr>{/each}</tbody></table></div>
  {/if}
  <p>Recordings stay in memory until saved. Keep runs under 100 seconds and start the transmitter promptly; capture stops after two minutes.</p>
</section>

<style>
  .experiment{border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:18px;background:var(--card);min-width:0}h2{font-size:18px;margin:0 0 10px}p{font-size:12px;line-height:1.5;color:var(--muted)}fieldset{border:0;padding:0;margin:0;min-width:0}.controls,.actions{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0;align-items:end}label{display:grid;gap:6px;font-size:12px;color:var(--muted)}input,select,textarea{background:var(--field);border:1px solid var(--line);border-radius:6px;padding:7px;color:var(--text);max-width:100%}input[type=number]{width:100px}textarea{width:100%}button{padding:8px 12px;background:#172945;color:#cfe3ff;border:1px solid #29476d;border-radius:8px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.scroll{overflow-x:auto;max-width:100%}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);white-space:nowrap}caption{text-align:left;margin:12px 0;color:var(--muted)}[role=alert]{color:#ff8da8}@media(max-width:520px){.experiment{padding:14px}.actions{align-items:stretch;flex-direction:column}input[type=file]{width:100%}}
</style>
