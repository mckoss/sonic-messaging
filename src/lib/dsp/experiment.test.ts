import { simulateChannel } from './channel';
import { describe, expect, it } from 'vitest';
import { CooperativeAnalyzer, controlWave, guardedWave, measureTrial, trialLayout, trialWave } from './experiment';
import { defaultSearch, validateSearch, validateTrial, encodeControl, decodeControl, ParameterSearch, type TrialMeasurement, type ControlMessage } from '../experiment';
import { CooperativeSession, type Outgoing } from '../cooperative-session';
const rate=8000,config=validateSearch(defaultSearch()),proposal={session:719,trial:0,settings:config.trial};
export function fixture(sampleRate=rate) {
  const a=guardedWave(controlWave({kind:'propose',...proposal},sampleRate),sampleRate), b=guardedWave(trialWave(proposal,sampleRate),sampleRate);
  const out=new Float32Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;
}
function analyze(samples:Float32Array) {
  const results:TrialMeasurement[]=[],problems:string[]=[];
  const analyzer=new CooperativeAnalyzer(rate,()=>{},r=>results.push(r),e=>problems.push(e));
  for(let i=0;i<samples.length;i+=128)analyzer.push(samples.subarray(i,i+128));
  return {results,problems};
}
describe('cooperative acoustic measurement',()=>{
  it('decodes control and measures known payload, with independent internal acquisition',()=>{
    const first=analyze(fixture());expect(first.problems).toEqual([]);expect(first.results).toHaveLength(1);
    expect(first.results[0].raw.bitErrors).toBe(0);expect(first.results[0].raw.bits).toBe(128);
    expect(first.results[0].acquisition.every(a=>a.exact&&a.acquired)).toBe(true);
    expect(analyze(fixture())).toEqual(first);
  });
  it('scores raw data despite destroyed test sync',()=>{
    const samples=fixture(),m=analyze(samples).results[0];
    samples.fill(0,Math.round(m.testStart),Math.round(m.testStart+16*m.samplesPerSymbol));
    const result=analyze(samples).results[0];expect(result.raw.bitErrors).toBe(0);
    expect(result.acquisition.every(a=>!a.acquired&&!a.exact)).toBe(true);
  });
  it('counts payload corruption without relying on successful CRC',()=>{
    const samples=fixture(),m=analyze(samples).results[0];
    samples.fill(0,Math.round(m.testStart+28*m.samplesPerSymbol),Math.round(m.testEnd));
    const result=analyze(samples).results[0];expect(result.raw.bitErrors).toBeGreaterThan(20);
    expect(result.acquisition.every(a=>!a.exact)).toBe(true);
  });
  it('retains reliable measurements through seeded noise and clock drift',()=>{
    const clean=fixture(),factor=1.0005,stretched=new Float32Array(Math.ceil(clean.length*factor));
    for(let i=0;i<stretched.length;i++){const x=i/factor,lo=Math.floor(x),f=x-lo;stretched[i]=(clean[lo]??0)*(1-f)+(clean[lo+1]??0)*f;}
    const result=analyze(simulateChannel(stretched,{snrDb:20,seed:918}));
    expect(result.problems).toEqual([]);expect(result.results).toHaveLength(1);
    expect(result.results[0].raw.bitErrors).toBe(0);
    expect(result.results[0].samplesPerSymbol).toBeGreaterThan(80);
  });
  it('rejects inconsistent marker timing and does not score missing markers',()=>{
    const wave=trialWave(proposal,rate),l=trialLayout(proposal,rate);
    expect(()=>measureTrial(wave,rate,proposal,0,l.endMarker*1.02,rate)).toThrow('timing');
    expect(analyze(fixture().subarray(0,16000)).results).toEqual([]);
  });
  it.each([2,4,8,16])('measures %i tones with payload-only bit counts',tones=>{
    const p={...proposal,settings:validateTrial({...proposal.settings,tones,lowestFrequency:800})},wave=trialWave(p,rate),l=trialLayout(p,rate);
    const m=measureTrial(wave,rate,p,0,l.endMarker,rate);expect(m.raw.bits).toBe(128);expect(m.raw.bitErrors).toBe(0);
  });
});
describe('control protocol and search',()=>{
  it.each([0.01,0.15,0.5])('round trips power boundary %s',amplitude=>{
    const m:ControlMessage={kind:'propose',...proposal,settings:validateTrial({...proposal.settings,amplitude})};
    expect(decodeControl(encodeControl(m))).toEqual(m);
  });
  it('rejects malformed and impossible feedback',()=>{
    expect(decodeControl(new Uint8Array(10))).toBeUndefined();
    expect(decodeControl(encodeControl({kind:'result',session:1,trial:0,raw:{symbolErrors:2,symbols:1,bitErrors:0,bits:8,confidence:1}}))).toBeUndefined();
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
    const analyzers=[0,1].map(i=>new CooperativeAnalyzer(rate,m=>controls[i].push(m),m=>sessions[i].measured(m),e=>{throw Error(e);},i===1));
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
  it('bounds silence retries and rejects stale feedback',()=>{
    const queue:Outgoing[]=[],finished:string[]=[];
    const session=new CooperativeSession('controller',config,719,a=>queue.push(a),e=>{if(e.kind==='status'&&e.finished)finished.push(e.detail);});
    session.start(0);
    session.receive({kind:'ready',session:718,trial:0});expect(queue).toHaveLength(1);
    for(let i=0;i<4;i++){session.sent(i*21000);session.tick((i+1)*21000);}
    expect(queue).toHaveLength(4);expect(finished[0]).toContain('timed out');
  });
  it('searches using measured symbol error rates and obeys its budget',()=>{
    const s=new ParameterSearch({...config,budget:8});
    for(let i=0;i<8;i++){const settings=s.next()!;expect(settings).toBeDefined();s.add({session:1,trial:i,settings,raw:{symbolErrors:settings.lowestFrequency===600?0:10,symbols:64,bits:128,bitErrors:10,confidence:.8}});}
    expect(s.next()).toBeUndefined();expect(s.best()?.value).toBe(600);
    expect(s.add(s.observations[0])).toBe(false);
  });
});
