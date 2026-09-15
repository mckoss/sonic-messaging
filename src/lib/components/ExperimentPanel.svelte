<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { AudioEngine } from '../audio';
  import { DEVICE_SENDER } from '../sender';
  import { senderHex } from '../dsp/frame';
  import { describeSettings } from '../experiment';
  import { encodeRecording, decodeRecording, MAX_RECORDING_BYTES, type Recording, type RecordingMetadata } from '../audio/recording';
  import { RecordingWriter, listRecordings, deleteRecording, clearRecordings, loadStoredRecording, storedRecordingBlob, type StoredRecording } from '../audio/recording-store';
  import { defaultSearch, estimateRunSeconds, spacingForBaud, totalTests, validateSearch, validateTrial, CONTROL_FSK, MAX_SESSION_SECONDS, MAX_REPETITIONS, type TrialMeasurement, type SearchObservation, type Proposal, type RawResult, type SearchSettings } from '../experiment';
  export let active = false;
  export let unavailable = false;
  export let inputDeviceId = 'default';
  export let beforeStart: () => Promise<void>;
  let engine: AudioEngine;
  let config = defaultSearch();
  let measurements: TrialMeasurement[] = [], feedback: SearchObservation[] = [], lostTrials: Proposal[] = [];
  type Row = { sender:number; trial:number; settings:Proposal['settings']; outcome:'received'|'CRC failed'|'lost'; raw?:RawResult; regime?:string; at:Date };
  type Run = { sender:number; settings:Proposal['settings']; regime?:string; started:Date; last:number; rows:Row[] };
  /** Rows in the order they arrived, so the newest are always last. */
  let rows: Row[] = [];
  let regime: string | undefined;
  const addRow=(row:Omit<Row,'at'|'regime'>)=>{rows=[...rows,{...row,regime,at:new Date()}];};
  const describeRegime=(run:SearchSettings)=>{
    const label={lowestFrequency:'base frequency',spacing:'tone spacing',tones:'number of tones',symbolRate:'test baud'}[run.parameter];
    const range=run.parameter==='tones'?'2–16':`${run.minimum}–${run.maximum} step ${run.step}`;
    return `varying ${label} ${range} · ${totalTests(run)} test${totalTests(run)===1?'':'s'}, ${run.repetitions}× each`;
  };
  // A partner keeps listening across controller runs: a new sender, or trial numbers starting over, begins a new run.
  $: runs=rows.reduce((all:Run[],row)=>{
    const current=all[all.length-1];
    if(!current||current.sender!==row.sender||row.trial<=current.last)
      all.push({sender:row.sender,settings:row.settings,regime:row.regime,started:row.at,last:row.trial,rows:[row]});
    else {current.rows.push(row);current.last=row.trial;}
    return all;
  },[]);
  let best: {value:number;errors:number;symbols:number} | undefined;
  // `recording` is an in-memory run (a loaded file, or a stored run loaded for replay); `currentId` names the latest stored run.
  let recording: Recording | undefined, writer: RecordingWriter | undefined, currentId: string | undefined;
  let library: StoredRecording[] = [], storageUsage = '', finishing: Promise<void> = Promise.resolve();
  let status = 'Start the partner first, then run a trial or optimize on the controller.';
  let error = '', notes = '', seconds = 0, finalizing = false, cancelled = false;
  let role: 'idle' | 'controller' | 'partner' | 'replay' = 'idle';
  let log: string[] = [], logBox: HTMLOListElement;
  function append(entry:string){log=[...log,entry].slice(-2000);void tick().then(()=>{if(logBox)logBox.scrollTop=logBox.scrollHeight;});}
  const megabytes=(bytes:number)=>`${(bytes/1048576).toFixed(1)} MB`;
  $: plan=(()=>{try{
    const run=validateSearch(config);
    return {tests:totalTests(run),seconds:estimateRunSeconds(run)};
  }catch{return undefined;}})();
  const duration=(s:number)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  async function refreshLibrary() {
    try {
      library=await listRecordings();
      const estimate=await navigator.storage?.estimate?.();
      storageUsage=estimate?.usage!==undefined&&estimate.quota?`Browser storage: ${megabytes(estimate.usage)} used of ${megabytes(estimate.quota)} available.`:'';
    } catch(e){storageUsage=`Saved recordings unavailable: ${e instanceof Error?e.message:String(e)}`;}
  }
  async function currentRecording():Promise<Recording|undefined> {
    await finishing;
    if(!recording&&currentId)recording=await loadStoredRecording(currentId);
    return recording;
  }
  async function saveCurrent() {
    error='';
    try {
      await finishing;
      if(currentId&&!recording)download('sonic-cooperative.wav',await storedRecordingBlob(currentId),'audio/wav');
      else if(recording)download('sonic-cooperative.wav',encodeRecording(recording),'audio/wav');
    } catch(e){error=String(e);}
  }
  async function openStored(entry:StoredRecording) {
    error='';
    try {
      recording=await loadStoredRecording(entry.id);currentId=entry.id;notes=entry.metadata.notes;
      if(entry.metadata.cooperative?.config)config=entry.metadata.cooperative.config;
      await replay();
    } catch(e){error=String(e);}
  }
  async function saveStored(entry:StoredRecording) {
    error='';
    try {download(`sonic-${entry.role}-${entry.createdAt.replace(/[:.]/g,'-')}.wav`,await storedRecordingBlob(entry.id),'audio/wav');}
    catch(e){error=String(e);}
  }
  async function removeStored(entry:StoredRecording) {
    error='';
    try {
      await deleteRecording(entry.id);
      if(currentId===entry.id){currentId=undefined;recording=undefined;}
    } catch(e){error=String(e);}
    await refreshLibrary();
  }
  async function clearStored() {
    if(!confirm(`Delete all ${library.length} saved recordings from this browser?`))return;
    error='';
    try {await clearRecordings();if(currentId){currentId=undefined;recording=undefined;}}
    catch(e){error=String(e);}
    await refreshLibrary();
  }
  function download(name:string,data:BlobPart,type:string) {
    const url=URL.createObjectURL(new Blob([data],{type})),link=document.createElement('a');
    link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function stop() {
    if(finalizing)return;
    finalizing=true;cancelled=true;
    if(role==='replay')engine.stopReplay();
    else { engine.stopCooperative();engine.stopListening(); }
    if(writer){
      const w=writer,trials=measurements.length||feedback.length;writer=undefined;
      finishing=w.finish(trials,measurements).catch(e=>{error=`Recording could not be saved: ${e instanceof Error?e.message:String(e)}`;}).then(refreshLibrary);
    }
    active=false;role='idle';finalizing=false;status='Stopped; partial recordings and completed measurements are retained.';
  }
  async function start(selected:'controller'|'partner') {
    error='';
    try {
      const run=selected==='controller'?validateSearch(config):undefined;
      active=true;role=selected;cancelled=false;seconds=0;measurements=[];feedback=[];lostTrials=[];rows=[];best=undefined;recording=undefined;currentId=undefined;log=[];
      await beforeStart();await engine.startListening(inputDeviceId);
      if(cancelled){engine.stopListening();return;}
      const metadata:RecordingMetadata={format:'sonic-recording',version:1,createdAt:new Date().toISOString(),
        appVersion:__APP_VERSION__,sampleRate:engine.state.sampleRate!,inputSettings:{...engine.state.inputSettings},
        fsk:CONTROL_FSK,userAgent:navigator.userAgent,notes,cooperative:{version:1,role:selected,sender:DEVICE_SENDER,config:run}};
      try {
        const created=await RecordingWriter.create(metadata,e=>{append(`Recording stopped (${e.message}); measurements continue.`);});
        if(cancelled){void created.finish(0);return;}
        writer=created;currentId=created.id;void refreshLibrary();
      } catch(e){append(`Recording unavailable (${e instanceof Error?e.message:String(e)}); measurements continue without a saved recording.`);}
      if(cancelled)return;
      regime=run?describeRegime(run):undefined;
      engine.configureCooperative(selected,run,DEVICE_SENDER);
    } catch(e){error=String(e);stop();}
  }
  async function load(event:Event) {
    const input=event.currentTarget as HTMLInputElement,file=input.files?.[0];if(!file)return;
    error='';active=true;
    try {
      if(file.size>MAX_RECORDING_BYTES)throw new Error('File is too large');
      const loaded=decodeRecording(await file.arrayBuffer());
      if(!loaded.metadata.cooperative)throw new Error('This WAV has no cooperative experiment metadata. Older recordings can be opened in the general recording panel.');
      if(loaded.metadata.cooperative.config)config=loaded.metadata.cooperative.config;recording=loaded;currentId=undefined;notes=loaded.metadata.notes;
      measurements=[];feedback=[];lostTrials=[];rows=[];best=undefined;log=[];status='Recording loaded. Replay to recompute measurements from its samples.';
    }catch(e){error=String(e);}finally{input.value='';active=false;}
  }
  async function replay() {
    active=true;role='replay';cancelled=false;measurements=[];feedback=[];lostTrials=[];rows=[];best=undefined;log=[];error='';
    try {
      const recording=await currentRecording();if(!recording)return;
      await beforeStart();status='Replaying recorded control messages and test packets…';
      await engine.replayRecording(recording,CONTROL_FSK,p=>seconds=p);
      recording.metadata.cooperative!.measurements=measurements;
      status=cancelled?'Replay stopped; partial results only.':'Replay complete. Test packets were received from the recording as ordinary frames.';
    }catch(e){error=String(e);}finally{active=false;role='idle';}
  }
  onMount(()=>{
    engine=new AudioEngine();
    const off=engine.onCooperative(event=>{
      if(event.kind==='wire')append(event.line);
      else if(event.kind==='measurement'){
        measurements=[...measurements,event.measurement];
        addRow({...event.measurement,outcome:event.measurement.raw.crcOk?'received':'CRC failed',raw:event.measurement.raw});
      }
      else if(event.kind==='feedback'){
        feedback=[...feedback,event.observation];best=event.best;
        // The controller's own rows come from results the partner sent back; a partner scores its own.
        if(role==='controller')addRow({...event.observation,outcome:event.observation.raw.crcOk?'received':'CRC failed',raw:event.observation.raw});
      }
      else if(event.kind==='lost'){lostTrials=[...lostTrials,event.proposal];addRow({...event.proposal,outcome:'lost'});}
      else if(!finalizing && role!=='idle'){
        status=event.detail;
        if(event.finished||event.log)append(event.detail);
        if(event.finished&&role!=='replay'){const detail=status;stop();status=detail;}
      }
    });
    void refreshLibrary();
    const offCapture=engine.onCapture(event=>{
      if(!writer||writer.failed)return;
      try {const full=writer.append(event.samples,event.sampleRate,event.sequence);seconds=writer.seconds;if(full)stop();}
      catch(e){error=String(e);stop();}
    });
    const offHealth=engine.onWorkerHealth(value=>{if(!value.healthy){error=value.reason??'Experiment worker unavailable';stop();}});
    return ()=>{off();offCapture();offHealth();void engine.dispose();};
  });
</script>
<section class="experiment" aria-label="Cooperative experiment">
  <h2>Cooperative FSK experiment</h2>
  <p>Two devices negotiate each test over a fixed stronger acoustic control channel. Keep device volume, distance and background conditions fixed. Raw symbol errors guide the search; acquisition is evaluated separately by internal recording replay. Payload FEC: none.</p>
  <p>Settings apply only on the controller. A partner needs no configuration: it measures whatever trial the controller requests, follows a restarted controller, and keeps listening until stopped.</p>
  <fieldset disabled={active || unavailable}>
    <div class="controls">
      <label>Test tones <select bind:value={config.trial.tones}>{#each [2,4,8,16] as n}<option value={n}>{n}</option>{/each}</select></label>
      <label>Base frequency <input type="number" bind:value={config.trial.lowestFrequency} /></label>
      <label>Tone spacing <input type="number" bind:value={config.trial.spacing} disabled={config.parameter==='symbolRate'} /></label>
      <label>Test baud <input type="number" bind:value={config.trial.symbolRate} /></label>
      <label>Payload bytes <input type="number" min="4" max="64" bind:value={config.trial.payloadBytes} /></label>
      <label>Data seed <input type="number" bind:value={config.trial.seed} /></label>
    </div>
    <div class="controls">
      <label>Optimize parameter <select bind:value={config.parameter}><option value="lowestFrequency">Base frequency</option><option value="spacing">Tone spacing</option><option value="tones">Number of tones</option><option value="symbolRate">Test baud</option></select></label>
      {#if config.parameter === 'symbolRate'}<p class="estimate">Tone spacing follows each baud: 2 × baud (e.g. {spacingForBaud(config.trial.symbolRate)} Hz at {config.trial.symbolRate} baud)</p>{/if}
      {#if config.parameter !== 'tones'}
        <label>Minimum <input type="number" bind:value={config.minimum} /></label>
        <label>Maximum <input type="number" bind:value={config.maximum} /></label>
        <label>Step <input type="number" min="1" bind:value={config.step} /></label>
      {/if}
      <label>Repetitions per test <input type="number" min="1" max={MAX_REPETITIONS} bind:value={config.repetitions} /></label>
      {#if plan}<p class="estimate" data-testid="test-estimate" class:over={plan.seconds > MAX_SESSION_SECONDS}>{plan.tests} test{plan.tests === 1 ? '' : 's'} · ≈ {duration(plan.seconds)} without retries{#if plan.seconds > MAX_SESSION_SECONDS} · over the 10-minute session limit; later tests won't run{/if}</p>{/if}
    </div>
    <label>Experiment notes <textarea rows="2" maxlength="4000" bind:value={notes} placeholder="Devices, distance, orientation, volume, background noise"></textarea></label>
    <div class="actions"><button on:click={()=>start('partner')}>Listen as partner</button><button on:click={()=>start('controller')}>Start Test</button><label>Load experiment WAV <input type="file" accept=".wav" on:change={load} /></label></div>
  </fieldset>
  {#if active}<button on:click={stop}>Stop experiment</button>{/if}
  <p role="status" data-testid="experiment-status">{status} {active?`${seconds.toFixed(1)} s`:''}</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if log.length}<ol class="log" data-testid="experiment-log" aria-label="Experiment log" bind:this={logBox}>{#each log as entry}<li>{entry}</li>{/each}</ol>{/if}
  <div class="actions">
    {#if recording || currentId}<button disabled={active || unavailable} on:click={saveCurrent}>Save experiment WAV</button><button disabled={active || unavailable} on:click={replay}>Replay experiment</button>{/if}
    {#if rows.length}<button disabled={active} on:click={()=>download('sonic-cooperative-results.json',JSON.stringify({config,measurements,feedback,lostTrials,best,appVersion:__APP_VERSION__},null,2),'application/json')}>Save experiment results</button>{/if}
  </div>
  {#if best}<p>Best measured {config.parameter}: {best.value} · {best.errors}/{best.symbols} symbol errors. Finite samples do not establish a global optimum.</p>{/if}
  <div class="scroll"><table data-testid="experiment-results"><thead><tr><th>Trial</th><th>Tones / base / spacing</th><th>Reception</th><th>Symbol errors</th><th>Median S/N</th></tr></thead><tbody>
    {#each runs as run}
      <tr class="run-divider"><th colspan="5">Run from {senderHex(run.sender)} · {run.started.toLocaleTimeString()} · {describeSettings(run.settings)}{run.regime ? ` · ${run.regime}` : ''}</th></tr>
      {#each run.rows as row}<tr><td>{row.trial+1}</td><td>{row.settings.tones} / {row.settings.lowestFrequency} / {row.settings.spacing}</td><td>{row.outcome}</td><td>{row.raw?`${row.raw.symbolErrors}/${row.raw.symbols}`:'—'}</td><td>{row.raw?`${row.raw.snrMedianDb.toFixed(1)} dB`:'—'}</td></tr>{/each}
    {/each}
  </tbody></table></div>
  <section class="library" aria-label="Saved recordings" data-testid="recordings">
    <div class="library-head"><h3>Saved recordings</h3><button disabled={active || !library.length} on:click={clearStored}>Clear all</button></div>
    <p>Each run is saved in this browser while it records, up to 10 minutes. {storageUsage}</p>
    {#if library.length}
      <div class="scroll"><table><thead><tr><th>Recorded</th><th>Role</th><th>Length</th><th>Trials</th><th>Size</th><th></th></tr></thead><tbody>
        {#each library as entry (entry.id)}<tr>
          <td>{new Date(entry.createdAt).toLocaleString()}{entry.complete ? '' : ' (partial)'}</td><td>{entry.role}</td><td>{duration(entry.seconds)}</td>
          <td>{entry.trials}</td><td>{megabytes(entry.bytes)}</td>
          <td class="row-actions"><button disabled={active || unavailable || entry.id === writer?.id} on:click={()=>openStored(entry)}>Replay</button><button disabled={entry.id === writer?.id} on:click={()=>saveStored(entry)}>Save WAV</button><button disabled={active} on:click={()=>removeStored(entry)}>Delete</button></td>
        </tr>{/each}
      </tbody></table></div>
    {:else}<p>No saved recordings.</p>{/if}
  </section>
  <p>Control: 4-FSK, 100 baud, 1000–1600 Hz; control and test packets both play at amplitude 0.8; plain-text messages such as <code>test_suite(1, 1000, 200, 4, 100, 16, 719)</code> in a frame carrying this device's sender ID <code>{senderHex(DEVICE_SENDER)}</code> a sequence number and a CRC (no FEC). Frames that ask for an ACK are retried up to 3 times, 4 seconds apart; a test packet is never re-sent, and a trial the partner did not receive is proposed again as a new trial. Sessions stop after 10 minutes; each run is saved to this browser's storage as it records. The partner receives each test packet as an ordinary frame on a second listener: received, CRC failed (symbols still scored), or lost if it isn't heard in time. S/N is in-window per symbol (winning tone vs. the rest of the window), not a calibrated acoustic measurement.</p>
</section>
<style>
.experiment{border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:18px;background:var(--card);min-width:0}h2{font-size:18px;margin:0 0 10px}p{font-size:12px;line-height:1.5;color:var(--muted)}fieldset{border:0;padding:0;margin:0;min-width:0}.controls,.actions{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0;align-items:end}label{display:grid;gap:6px;font-size:12px;color:var(--muted)}input,select,textarea{background:var(--field);border:1px solid var(--line);border-radius:6px;padding:7px;color:var(--text);max-width:100%}input[type=number]{width:100px}button{padding:8px 12px;background:#172945;color:#cfe3ff;border:1px solid #29476d;border-radius:8px;cursor:pointer}button:disabled{opacity:.45}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);white-space:nowrap}[role=alert]{color:#ff8da8}.run-divider th{padding-top:12px;color:var(--blue);font-weight:650;white-space:normal;border-bottom:1px solid var(--blue)}.library{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}.library-head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}h3{font-size:15px;margin:0}.row-actions{display:flex;gap:6px}.row-actions button{padding:5px 9px}.estimate{margin:0;align-self:center}.estimate.over{color:#ffcf6e}.log{list-style:none;margin:12px 0;padding:10px;max-height:200px;overflow:auto;background:var(--field);border:1px solid var(--line);border-radius:8px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}.log li{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:520px){.experiment{padding:14px}.actions{align-items:stretch;flex-direction:column}input[type=file]{width:100%}}
</style>
