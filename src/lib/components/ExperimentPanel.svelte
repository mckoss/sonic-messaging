<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { AudioEngine } from '../audio';
  import { RecordingCapture, encodeRecording, decodeRecording, MAX_RECORDING_BYTES, type Recording } from '../audio/recording';
  import { defaultSearch, validateSearch, CONTROL_FSK, type TrialMeasurement, type SearchObservation, type Proposal } from '../experiment';
  export let active = false;
  export let unavailable = false;
  export let inputDeviceId = 'default';
  export let beforeStart: () => Promise<void>;
  let engine: AudioEngine;
  let config = defaultSearch();
  let measurements: TrialMeasurement[] = [], feedback: SearchObservation[] = [];
  let best: {value:number;errors:number;symbols:number} | undefined;
  let recording: Recording | undefined, capture: RecordingCapture | undefined;
  let status = 'Start the partner first, then run a trial or optimize on the controller.';
  let error = '', notes = '', seconds = 0, finalizing = false, cancelled = false;
  let role: 'idle' | 'controller' | 'partner' | 'replay' = 'idle';
  let log: string[] = [], logBox: HTMLOListElement;
  const describe=(p:Proposal)=>`Trial ${p.trial+1}, Tones=${p.settings.tones}, Base=${p.settings.lowestFrequency}, Delta=${p.settings.spacing}, Baud=${p.settings.symbolRate}`;
  const received=(raw:{symbolErrors:number;symbols:number})=>`Symbols received ${raw.symbols-raw.symbolErrors}/${raw.symbols}`;
  function append(entry:string){log=[...log,entry].slice(-200);void tick().then(()=>{if(logBox)logBox.scrollTop=logBox.scrollHeight;});}
  function download(name:string,data:BlobPart,type:string) {
    const url=URL.createObjectURL(new Blob([data],{type})),link=document.createElement('a');
    link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function stop() {
    if(finalizing)return;
    finalizing=true;cancelled=true;
    if(role==='replay')engine.stopReplay();
    else { engine.stopCooperative();engine.stopListening(); }
    if(capture){recording=capture.finish();capture=undefined;recording.metadata.cooperative!.measurements=measurements;}
    active=false;role='idle';finalizing=false;status='Stopped; partial recordings and completed measurements are retained.';
  }
  async function start(selected:'controller'|'partner',single=false) {
    error='';
    try {
      const run=selected==='controller'?validateSearch({...config,budget:single?1:config.budget}):undefined;
      active=true;role=selected;cancelled=false;seconds=0;measurements=[];feedback=[];best=undefined;recording=undefined;log=[];
      await beforeStart();await engine.startListening(inputDeviceId);
      if(cancelled){engine.stopListening();return;}
      capture=new RecordingCapture({format:'sonic-recording',version:1,createdAt:new Date().toISOString(),
        appVersion:__APP_VERSION__,sampleRate:engine.state.sampleRate!,inputSettings:{...engine.state.inputSettings},
        fsk:CONTROL_FSK,userAgent:navigator.userAgent,notes,cooperative:{version:1,config:run}});
      engine.configureCooperative(selected,run,crypto.getRandomValues(new Uint32Array(1))[0]);
    } catch(e){error=String(e);stop();}
  }
  async function load(event:Event) {
    const input=event.currentTarget as HTMLInputElement,file=input.files?.[0];if(!file)return;
    error='';active=true;
    try {
      if(file.size>MAX_RECORDING_BYTES)throw new Error('File is too large');
      const loaded=decodeRecording(await file.arrayBuffer());
      if(!loaded.metadata.cooperative)throw new Error('This WAV has no cooperative experiment metadata. Older recordings can be opened in the general recording panel.');
      if(loaded.metadata.cooperative.config)config=loaded.metadata.cooperative.config;recording=loaded;notes=loaded.metadata.notes;
      measurements=[];feedback=[];best=undefined;log=[];status='Recording loaded. Replay to recompute measurements from its samples.';
    }catch(e){error=String(e);}finally{input.value='';active=false;}
  }
  async function replay() {
    if(!recording)return;
    active=true;role='replay';cancelled=false;measurements=[];feedback=[];best=undefined;log=[];error='';
    try {
      await beforeStart();status='Replaying recorded control markers and test data…';
      await engine.replayRecording(recording,CONTROL_FSK,p=>seconds=p);
      recording.metadata.cooperative!.measurements=measurements;
      status=cancelled?'Replay stopped; partial results only.':'Replay complete. Unknown timing was tested internally on the same samples.';
    }catch(e){error=String(e);}finally{active=false;role='idle';}
  }
  onMount(()=>{
    engine=new AudioEngine();
    const off=engine.onCooperative(event=>{
      if(event.kind==='trial')append(`${event.direction==='sent'?'<-':'->'} ${describe(event.proposal)}`);
      else if(event.kind==='measurement'){
        measurements=[...measurements,event.measurement];
        append(role==='replay'?`${describe(event.measurement)}: ${received(event.measurement.raw)}`:`<- ${received(event.measurement.raw)}`);
      }
      else if(event.kind==='feedback'){feedback=[...feedback,event.observation];best=event.best;append(`-> ${received(event.observation.raw)}`);}
      else if(!finalizing && role!=='idle'){
        status=event.detail;
        if(event.finished||event.log)append(event.detail);
        if(event.finished&&role!=='replay'){const detail=status;stop();status=detail;}
      }
    });
    const offCapture=engine.onCapture(event=>{
      if(!capture)return;
      try {const full=capture.append(event.samples,event.sampleRate,event.sequence);seconds=capture.seconds;if(full)stop();}
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
      <label>Tone spacing <input type="number" bind:value={config.trial.spacing} /></label>
      <label>Test baud <input type="number" bind:value={config.trial.symbolRate} /></label>
      <label>Test amplitude <input type="number" min="0.01" max="0.5" step="0.01" bind:value={config.trial.amplitude} /></label>
      <label>Payload bytes <input type="number" min="4" max="64" bind:value={config.trial.payloadBytes} /></label>
      <label>Data seed <input type="number" bind:value={config.trial.seed} /></label>
      <label>Quiet guard (seconds) <input type="number" min="0.25" max="1.5" step="0.25" bind:value={config.trial.guardSeconds} /></label>
    </div>
    <div class="actions"><button on:click={()=>start('controller',true)}>Run one trial</button></div>
    <div class="controls">
      <label>Optimize parameter <select bind:value={config.parameter}><option value="lowestFrequency">Base frequency</option><option value="spacing">Tone spacing</option><option value="tones">Number of tones</option></select></label>
      {#if config.parameter !== 'tones'}
        <label>Minimum <input type="number" bind:value={config.minimum} /></label>
        <label>Maximum <input type="number" bind:value={config.maximum} /></label>
        <label>Minimum step <input type="number" bind:value={config.step} /></label>
      {/if}
      <label>Trial budget <input type="number" min="1" max="16" bind:value={config.budget} /></label>
    </div>
    <label>Experiment notes <textarea rows="2" maxlength="4000" bind:value={notes} placeholder="Devices, distance, orientation, volume, background noise"></textarea></label>
    <div class="actions"><button on:click={()=>start('partner')}>Listen as partner</button><button on:click={()=>start('controller')}>Optimize</button><label>Load experiment WAV <input type="file" accept=".wav" on:change={load} /></label></div>
  </fieldset>
  {#if active}<button on:click={stop}>Stop experiment</button>{/if}
  <p role="status" data-testid="experiment-status">{status} {active?`${seconds.toFixed(1)} s`:''}</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if log.length}<ol class="log" data-testid="experiment-log" aria-label="Experiment log" bind:this={logBox}>{#each log as entry}<li>{entry}</li>{/each}</ol>{/if}
  <div class="actions">
    {#if recording}<button disabled={active || unavailable} on:click={()=>download('sonic-cooperative.wav',encodeRecording(recording!),'audio/wav')}>Save experiment WAV</button><button disabled={active || unavailable} on:click={replay}>Replay experiment</button>{/if}
    {#if measurements.length || feedback.length}<button disabled={active} on:click={()=>download('sonic-cooperative-results.json',JSON.stringify({config,measurements,feedback,best,appVersion:__APP_VERSION__},null,2),'application/json')}>Save experiment results</button>{/if}
  </div>
  {#if best}<p>Best measured {config.parameter}: {best.value} · {best.errors}/{best.symbols} symbol errors. Finite samples do not establish a global optimum.</p>{/if}
  <div class="scroll"><table data-testid="experiment-results"><thead><tr><th>Trial</th><th>Tones / base / spacing</th><th>Raw symbol errors</th><th>Internal acquisition / exact message</th></tr></thead><tbody>
    {#each measurements.length ? measurements : feedback as row}<tr><td>{row.trial+1}</td><td>{row.settings.tones} / {row.settings.lowestFrequency} / {row.settings.spacing}</td><td>{row.raw.symbolErrors}/{row.raw.symbols}</td><td>{#if 'acquisition' in row}{(row as TrialMeasurement).acquisition.filter(a=>a.acquired).length}/4 acquired · {(row as TrialMeasurement).acquisition.filter(a=>a.exact).length}/4 exact{:else}See partner recording{/if}</td></tr>{/each}
  </tbody></table></div>
  <p>Control: 4-FSK, 100 baud, 1000–1600 Hz, amplitude 0.9, CRC (no FEC) with acknowledgement and retries after 4.5 seconds without a reply. Lost feedback is re-queried, never re-measured; a trial the partner never heard is proposed again as a new trial. Sessions stop after 110 seconds; recordings stay in memory until saved. Both timing markers must be received to score a trial. Error counts are measured; calibrated acoustic S/N is not yet available.</p>
</section>
<style>
.experiment{border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:18px;background:var(--card);min-width:0}h2{font-size:18px;margin:0 0 10px}p{font-size:12px;line-height:1.5;color:var(--muted)}fieldset{border:0;padding:0;margin:0;min-width:0}.controls,.actions{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0;align-items:end}label{display:grid;gap:6px;font-size:12px;color:var(--muted)}input,select,textarea{background:var(--field);border:1px solid var(--line);border-radius:6px;padding:7px;color:var(--text);max-width:100%}input[type=number]{width:100px}button{padding:8px 12px;background:#172945;color:#cfe3ff;border:1px solid #29476d;border-radius:8px;cursor:pointer}button:disabled{opacity:.45}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);white-space:nowrap}[role=alert]{color:#ff8da8}.log{list-style:none;margin:12px 0;padding:10px;max-height:200px;overflow:auto;background:var(--field);border:1px solid var(--line);border-radius:8px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}.log li{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:520px){.experiment{padding:14px}.actions{align-items:stretch;flex-direction:column}input[type=file]{width:100%}}
</style>
