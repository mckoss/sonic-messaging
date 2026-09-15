import { simulateChannel } from './channel';
import { describe, expect, it } from 'vitest';
import { CooperativeAnalyzer, controlWave, guardedWave, trialWave, type AnalyzerOptions } from './experiment';
import { MAX_TESTS, controlText, estimateTestSeconds, testListenSeconds, testSymbolCount, trialFsk, defaultSearch, describeControl, hexBytes, trialPayload, validateSearch, validateTrial, encodeControl, decodeControl, ParameterSearch, type Proposal, type TrialMeasurement, type ControlMessage } from '../experiment';
import { CooperativeSession, type Outgoing } from '../cooperative-session';
import { PAYLOAD_OFFSET } from './frame';
const rate=8000,config=validateSearch(defaultSearch()),proposal={sender:719,trial:0,settings:config.trial};
/** test_suite, then the test packet as an ordinary guarded frame, then enough quiet for the listener window to close. */
export function fixture(p:Proposal=proposal,sampleRate=rate) {
  const a=guardedWave(controlWave({kind:'test_suite',...p},sampleRate),sampleRate),b=guardedWave(trialWave(p,sampleRate),sampleRate);
  const out=new Float32Array(a.length+b.length+Math.ceil(testListenSeconds(p.settings)*sampleRate));out.set(a);out.set(b,a.length);return out;
}
/** Sample index where the fixture's test packet frame starts. */
const packetStart=(sampleRate=rate)=>guardedWave(controlWave({kind:'test_suite',...proposal},sampleRate),sampleRate).length+sampleRate/2;
function analyze(samples:Float32Array,options:AnalyzerOptions={}) {
  const results:TrialMeasurement[]=[],lost:Proposal[]=[],lines:string[]=[];
  const analyzer=new CooperativeAnalyzer(rate,{analyze:true,measurement:r=>results.push(r),lost:p=>lost.push(p),wire:l=>lines.push(l),...options});
  for(let i=0;i<samples.length;i+=128)analyzer.push(samples.subarray(i,i+128));
  return {results,lost,lines};
}
const perSymbol=rate/config.trial.symbolRate;
describe('cooperative acoustic measurement',()=>{
  it('receives the test packet as an ordinary frame on a second listener and scores it',()=>{
    const first=analyze(fixture());expect(first.lost).toEqual([]);expect(first.results).toHaveLength(1);
    expect(first.results[0].raw).toMatchObject({crcOk:true,bitErrors:0,bits:128,symbolErrors:0,symbols:testSymbolCount(config.trial)});
    expect(first.results[0].received).toEqual([...trialPayload(config.trial)]);
    expect(Math.abs(first.results[0].startPosition-packetStart())).toBeLessThanOrEqual(2);
    expect(analyze(fixture())).toEqual(first);
  });
  it('scores the symbols of a frame whose CRC failed',()=>{
    const samples=fixture(),from=packetStart()+(PAYLOAD_OFFSET*4+8)*perSymbol;
    // Interference replaces 12 payload symbols with a steady wrong tone, so the carrier stays up but the CRC fails.
    const wrong=trialFsk(config.trial).frequencies[3];
    for(let i=from;i<from+12*perSymbol;i++)samples[i]=0.8*Math.sin(2*Math.PI*wrong*i/rate);
    const {results,lost}=analyze(samples);
    expect(lost).toEqual([]);expect(results).toHaveLength(1);
    expect(results[0].raw.crcOk).toBe(false);expect(results[0].raw.symbolErrors).toBeGreaterThan(4);
  });
  it('reports the test packet as lost when its sync header is missed',()=>{
    const samples=fixture();samples.fill(0,packetStart(),packetStart()+16*perSymbol);
    const {results,lost,lines}=analyze(samples);
    expect(results).toEqual([]);expect(lost).toEqual([proposal]);
    expect(lines[lines.length-1]).toMatch(/^X Trial 1 test packet not received \(listened \d+\.\d s\)$/);
  });
  it('tracks symbol timing through seeded noise and 500 ppm clock drift',()=>{
    const clean=fixture(),factor=1.0005,stretched=new Float32Array(Math.ceil(clean.length*factor));
    for(let i=0;i<stretched.length;i++){const x=i/factor,lo=Math.floor(x),f=x-lo;stretched[i]=(clean[lo]??0)*(1-f)+(clean[lo+1]??0)*f;}
    const {results}=analyze(simulateChannel(stretched,{snrDb:20,seed:918}));
    expect(results).toHaveLength(1);expect(results[0].raw.crcOk).toBe(true);expect(results[0].raw.bitErrors).toBe(0);
    expect(results[0].timingDriftMs).toBeGreaterThan(0.2);expect(results[0].timingDriftMs).toBeLessThan(1.2);
  });
  it('reports in-window S/N per symbol that falls with channel noise',()=>{
    const clean=analyze(fixture()).results[0],noisy=analyze(simulateChannel(fixture(),{snrDb:3,seed:44})).results[0];
    expect(clean.snrDb).toHaveLength(clean.raw.symbols);expect(noisy.snrDb).toHaveLength(noisy.raw.symbols);
    expect(clean.raw.snrMedianDb).toBeGreaterThan(20);
    expect(noisy.raw.snrMedianDb).toBeLessThan(clean.raw.snrMedianDb-10);
  });
  it('keeps absolute positions after a long quiet session',()=>{
    const quiet=rate*75,long=new Float32Array(quiet+fixture().length);long.set(fixture(),quiet);
    const late=analyze(long).results[0],early=analyze(fixture()).results[0];
    expect(late.raw).toEqual(early.raw);expect(late.startPosition).toBe(early.startPosition+quiet);
  });
  it('scores the packet as soon as its last symbol arrives, and ignores test packets nobody announced',()=>{
    const full=fixture(),cut=packetStart()+(PAYLOAD_OFFSET+config.trial.payloadBytes+1)*4*perSymbol,results:TrialMeasurement[]=[];
    const analyzer=new CooperativeAnalyzer(rate,{analyze:true,measurement:r=>results.push(r)});
    for(let i=0;i<cut;i+=128)analyzer.push(full.subarray(i,Math.min(cut,i+128)));
    expect(results).toEqual([]);
    const rest=packetStart()+(PAYLOAD_OFFSET+config.trial.payloadBytes+2)*4*perSymbol+rate/4;
    for(let i=cut;i<rest;i+=128)analyzer.push(full.subarray(i,Math.min(rest,i+128)));
    expect(results).toHaveLength(1);expect(results[0].raw.symbolErrors).toBe(0);
    expect(analyze(guardedWave(trialWave(proposal,rate),rate)).results).toEqual([]);
  });
  it.each([2,4,8,16])('measures %i tones with payload-only bit counts',tones=>{
    const p={...proposal,settings:validateTrial({...proposal.settings,tones,lowestFrequency:800})};
    const {results}=analyze(fixture(p));expect(results).toHaveLength(1);expect(results[0].raw.bits).toBe(128);expect(results[0].raw.bitErrors).toBe(0);
  });
});
describe('control protocol and search',()=>{
  it.each([2,4,8,16])('round trips test_suite settings with %i tones',tones=>{
    const m:ControlMessage={kind:'test_suite',...proposal,settings:validateTrial({...proposal.settings,tones,lowestFrequency:500})};
    expect(decodeControl(encodeControl(m),m.sender)).toEqual(m);
  });
  it('sends human-readable method calls and rejects malformed text',()=>{
    const text=(s:string)=>new TextEncoder().encode(s);
    // The sender travels in the frame, never in the message text.
    expect(controlText({kind:'test_suite',sender:0x1a2b,trial:0,settings:validateTrial(config.trial)})).toBe('test_suite(1, 1000, 200, 4, 100, 16, 719)');
    expect(controlText({kind:'result',sender:0x1a2b,trial:0,raw:{symbolErrors:2,symbols:64,bitErrors:3,bits:128,confidence:0.8234,snrMedianDb:-3.26,crcOk:false}})).toBe('result(1, 2, 64, 3, 128, 0.82, -3.3, 0)');
    expect(controlText({kind:'done',sender:0x1a2b,trial:8})).toBe('done(8)');
    expect(decodeControl(text('ready(4)'),0x1a2b)).toEqual({kind:'ready',sender:0x1a2b,trial:3});
    expect(decodeControl(text('done(8)'),0x1a2b)).toEqual({kind:'done',sender:0x1a2b,trial:8});
    for(const bad of ['ready()','ready(0)','hello(1)','ready(1','test(1, 48000)','ready(x)','ready(1, 2)','result(1, 2, 64, 3, 128, 0.8, 1, 2)'])expect(decodeControl(text(bad),1)).toBeUndefined();
    expect(decodeControl(new Uint8Array(10),1)).toBeUndefined();
    expect(decodeControl(encodeControl({kind:'result',sender:1,trial:0,raw:{symbolErrors:2,symbols:1,bitErrors:0,bits:8,confidence:1,snrMedianDb:20,crcOk:true}}),1)).toBeUndefined();
  });
  it('retries lost results without retransmitting measured data, and deduplicates feedback',()=>{
    const cq:Outgoing[]=[],pq:Outgoing[]=[],events:string[]=[];
    const c=new CooperativeSession('controller',{...config,budget:1},719,a=>cq.push(a),e=>events.push(e.kind));
    const p=new CooperativeSession('partner',config,0,a=>pq.push(a),()=>{});
    c.start(0);p.start(0);
    const propose=cq.shift()!;if(propose.kind!=='control')throw Error();c.sent(0);p.receive(propose.message);
    const ready=pq.shift()!;if(ready.kind!=='control')throw Error();p.sent(0);c.receive(ready.message);
    expect(cq.shift()?.kind).toBe('trial');c.sent(1000);
    p.measured(analyze(fixture()).results[0]);pq.shift();p.sent(2000); // lose result
    c.tick(22000);const query=cq.shift()!;expect(query.kind).toBe('control');
    if(query.kind!=='control')throw Error();expect(query.message.kind).toBe('query');p.receive(query.message);
    const result=pq.shift()!;if(result.kind!=='control')throw Error();c.receive(result.message);c.receive(result.message);
    expect(events.filter(e=>e==='feedback')).toHaveLength(1);expect(cq).toHaveLength(1);
    c.sent(23000);expect(cq[cq.length-1]?.kind).toBe('control');
  });
  it('runs two cooperative devices through actual acoustic control decoding',()=>{
    const queue:{from:number;action:Outgoing}[]=[],observations:number[]=[];
    const settings={...config,budget:2};let now=0;
    const sessions=[new CooperativeSession('controller',settings,719,a=>queue.push({from:0,action:a}),e=>{if(e.kind==='feedback')observations.push(e.observation.raw.bitErrors);}),
      new CooperativeSession('partner',settings,0,a=>queue.push({from:1,action:a}),()=>{})];
    const controls:ControlMessage[][]=[[],[]];
    const analyzers=[0,1].map(i=>new CooperativeAnalyzer(rate,{control:m=>controls[i].push(m),measurement:m=>sessions[i].measured(m),
      testHeard:p=>sessions[i].testHeard(p),lost:()=>{throw Error('lost');},analyze:i===1,self:i===0?719:0}));
    sessions[1].start(now);sessions[0].start(now);
    let bursts=0;
    for(let count=0;queue.length&&count<30;count++){
      const {from,action}=queue.shift()!;if(action.kind==='trial')bursts++;
      const wave=guardedWave(action.kind==='control'?controlWave(action.message,rate):trialWave(action.proposal,rate),rate);
      const noisy=simulateChannel(wave,{snrDb:25,seed:count+15});
      for(let offset=0;offset<wave.length;offset+=128){
        for(let i=0;i<2;i++)analyzers[i].push((i===from?wave:noisy).subarray(offset,offset+128));
      }
      now+=wave.length/rate*1000;sessions[from].sent(now);
      for(let i=0;i<2;i++)for(const m of controls[i].splice(0))sessions[i].receive(m);
    }
    expect(observations).toEqual([0,0]);expect(bursts).toBe(2);expect(queue).toHaveLength(0);
  });
  it('keeps a settings-free partner listening across restarted controller runs',()=>{
    const queue:Outgoing[]=[],finished:string[]=[];let accepted=0;
    const p=new CooperativeSession('partner',undefined,0,a=>queue.push(a),e=>{
      if(e.kind==='status'&&e.finished)finished.push(e.detail);
      if(e.kind==='status'&&e.detail.startsWith('Ready for trial'))accepted++;
    });
    // Replies carry the partner's own sender ID (0), whichever controller it follows.
    const ready=(trial:number)=>{const a=queue.shift();return a?.kind==='control'&&a.message.kind==='ready'&&a.message.sender===0&&a.message.trial===trial;};
    p.start(0);
    p.receive({kind:'test_suite',sender:1,trial:0,settings:config.trial});expect(ready(0)).toBe(true);p.sent(0);
    p.receive({kind:'test_suite',sender:1,trial:1,settings:config.trial});expect(ready(1)).toBe(true);p.sent(500);
    // The same controller stopped mid-run and restarted at trial 1 with different settings; no done was heard.
    p.receive({kind:'test_suite',sender:1,trial:0,settings:{...config.trial,spacing:300}});expect(ready(0)).toBe(true);p.sent(1000);
    // A different controller device takes over.
    p.receive({kind:'test_suite',sender:2,trial:0,settings:config.trial});expect(ready(0)).toBe(true);p.sent(1500);
    p.receive({kind:'done',sender:1,trial:1});p.receive({kind:'done',sender:2,trial:1});
    // Unanswered readiness gives up on the trial but never ends the session.
    p.receive({kind:'test_suite',sender:3,trial:0,settings:config.trial});expect(ready(0)).toBe(true);p.sent(2000);
    for(let i=0;i<7;i++){p.tick(2000+(i+1)*6500);queue.splice(0).forEach(()=>p.sent(2000+(i+1)*6500));}
    p.receive({kind:'test_suite',sender:4,trial:0,settings:config.trial});expect(ready(0)).toBe(true);
    expect(accepted).toBe(6);expect(finished).toEqual([]);
  });
  it('re-proposes a trial the partner never measured instead of querying until timeout',()=>{
    const cq:Outgoing[]=[],pq:Outgoing[]=[],logged:string[]=[],partnerLogged:string[]=[];
    const c=new CooperativeSession('controller',{...config,budget:2},719,a=>cq.push(a),e=>{if(e.kind==='status'&&e.log)logged.push(e.detail);});
    const p=new CooperativeSession('partner',undefined,0,a=>pq.push(a),e=>{if(e.kind==='status'&&e.log)partnerLogged.push(e.detail);});
    const control=(q:Outgoing[])=>{const a=q.shift()!;if(a.kind!=='control')throw Error(a.kind);return a.message;};
    c.start(0);p.start(0);
    p.receive(control(cq));c.sent(0);c.receive(control(pq));p.sent(1000);
    expect(cq.shift()?.kind).toBe('trial');c.sent(2000); // the partner never receives the test packet
    c.tick(2000+6100);const query=control(cq);expect(query.kind).toBe('query');
    p.receive(query);const lost=control(pq);expect(lost.kind).toBe('lost');c.receive(lost);
    const again=control(cq);expect(again.kind).toBe('test_suite');
    if(again.kind!=='test_suite')throw Error();expect(again.trial).toBe(1);expect(again.settings).toEqual(validateTrial(config.trial));
    expect(logged).toEqual(['No reply; retrying control exchange (1/5).','Partner did not receive trial 1; proposing it again.']);
    expect(partnerLogged[0]).toContain('Trial 1 test packet not received');
  });
  it('repeats the ack when the partner is still resending an earlier result',()=>{
    const cq:Outgoing[]=[];
    const c=new CooperativeSession('controller',{...config,budget:3},719,a=>cq.push(a),()=>{});
    c.start(0);cq.shift();c.sent(0);
    c.receive({kind:'ready',sender:42,trial:0});cq.shift();c.sent(1000);
    const symbols=testSymbolCount(config.trial);
    const result:ControlMessage={kind:'result',sender:42,trial:0,raw:{symbolErrors:0,symbols,bitErrors:0,bits:config.trial.payloadBytes*8,confidence:1,snrMedianDb:20,crcOk:true}};
    c.receive(result);cq.shift();c.sent(2000);expect(cq.shift()).toMatchObject({kind:'control',message:{kind:'test_suite',trial:1}});
    c.receive(result);expect(cq).toEqual([{kind:'control',message:{kind:'ack',sender:719,trial:0}}]);
  });
  it('reports corrupted control messages',()=>{
    const bad=guardedWave(controlWave({kind:'ready',sender:719,trial:0},rate),rate);const tail=Math.round(bad.length*0.55);bad.fill(0,tail,tail+Math.round(rate*0.08));
    const samples=new Float32Array(bad.length+fixture().length);samples.set(bad);samples.set(fixture(),bad.length);
    const {lines,results}=analyze(samples);
    const errors=lines.filter(l=>l.startsWith('X'));
    expect(errors).toHaveLength(1);expect(errors[0]).toMatch(/^X Garbled message "[^"]*" \[[0-9A-F ]+\] \((CRC failed|signal lost after \d+ of \d+ bytes)\)$/);
    expect(results).toHaveLength(1);
  });
  it('logs every received frame, raw then decoded, with per-symbol S/N for the test packet',()=>{
    const done=guardedWave(controlWave({kind:'done',sender:719,trial:1},rate),rate),samples=new Float32Array(fixture().length+done.length);
    samples.set(fixture());samples.set(done,fixture().length);
    const {lines}=analyze(samples);
    const payload=hexBytes(trialPayload(validateTrial(config.trial)));
    expect(lines[0]).toBe('-> 02CF test_suite(1, 1000, 200, 4, 100, 16, 719) · trial 1 settings: Base=1000, Delta=200, Tones=4, Baud=100, Bytes=16, Seed=719');
    // This default test uses the control tones and baud, so the control listener also decodes the packet; it is logged once, scored.
    expect(lines[1]).toMatch(new RegExp(`^-> 02CF test packet ${payload.replace(/[[\]]/g,'\\$&')} · trial 1: received, 64/64 symbols received, S/N dB \\[(-?\\d+ ){63}-?\\d+\\] median \\d+\\.\\d · drift [+−]\\d+\\.\\d ms$`));
    expect(lines.slice(2)).toEqual(['-> 02CF done(1) · run finished after 1 trials']);
    // The controller hears its own transmissions: dropped unlogged, before the session sees them.
    const heard:ControlMessage[]=[],controller=analyze(samples,{analyze:false,control:m=>heard.push(m),self:719});
    expect(controller.lines).toEqual([]);expect(heard).toEqual([]);
    expect(describeControl({kind:'result',sender:1,trial:2,raw:{symbolErrors:3,symbols:64,bitErrors:4,bits:128,confidence:1,snrMedianDb:18.26,crcOk:false}})).toBe('trial 3: CRC failed, 61/64 symbols received, median S/N 18.3 dB');
    expect(hexBytes([0x1a,0xef,5])).toBe('[1A EF 05]');
  });
  it('bounds silence retries and rejects stale feedback',()=>{
    const queue:Outgoing[]=[],finished:string[]=[];
    const session=new CooperativeSession('controller',config,719,a=>queue.push(a),e=>{if(e.kind==='status'&&e.finished)finished.push(e.detail);});
    session.start(0);
    session.receive({kind:'ready',sender:42,trial:5});session.receive({kind:'ready',sender:719,trial:0});expect(queue).toHaveLength(1); // wrong trial; own echo
    for(let i=0;i<6;i++){session.sent(i*6500);session.tick((i+1)*6500);}
    expect(queue).toHaveLength(6);expect(finished[0]).toContain('timed out');
  });
  it('estimates test duration so long runs can warn before hitting the session limit',()=>{
    const seconds=estimateTestSeconds(validateTrial(config.trial));
    expect(seconds).toBeGreaterThan(10);expect(seconds).toBeLessThan(25);
    expect(estimateTestSeconds(validateTrial({...config.trial,payloadBytes:64,symbolRate:25}))).toBeGreaterThan(seconds+10);
    expect(trialFsk(validateTrial(config.trial)).amplitude).toBe(0.8);
    expect(()=>validateSearch({...config,budget:MAX_TESTS+1})).toThrow('number of tests');
  });
  it('searches using measured symbol error rates and obeys its budget',()=>{
    const s=new ParameterSearch({...config,budget:8});
    for(let i=0;i<8;i++){const settings=s.next()!;expect(settings).toBeDefined();s.add({sender:1,trial:i,settings,raw:{symbolErrors:settings.lowestFrequency===600?0:10,symbols:64,bits:128,bitErrors:10,confidence:.8,snrMedianDb:20,crcOk:true}});}
    expect(s.next()).toBeUndefined();expect(s.best()?.value).toBe(600);
    expect(s.add(s.observations[0])).toBe(false);
  });
});
