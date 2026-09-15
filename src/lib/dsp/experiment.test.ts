import { simulateChannel } from './channel';
import { describe, expect, it } from 'vitest';
import { ackWave, CooperativeAnalyzer, controlWave, guardedWave, trialWave, type AnalyzerOptions } from './experiment';
import { MAX_TESTS, controlText, describeTestSent, describeWire, estimateTestSeconds, testListenSeconds, testSymbolCount, trialFsk, defaultSearch, describeControl, hexBytes, trialPayload, validateSearch, validateTrial, encodeControl, decodeControl, ParameterSearch, type Proposal, type TrialMeasurement, type ControlMessage, type CooperativeEvent } from '../experiment';
import { CooperativeSession } from '../cooperative-session';
import { PacketManager, type OutgoingPacket } from '../packet-manager';
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
    expect(decodeControl(text('lost(4)'),0x1a2b)).toEqual({kind:'lost',sender:0x1a2b,trial:3});
    expect(decodeControl(text('done(8)'),0x1a2b)).toEqual({kind:'done',sender:0x1a2b,trial:8});
    for(const bad of ['lost()','lost(0)','hello(1)','lost(1','ready(1)','ack(1)','query(1)','lost(x)','lost(1, 2)','result(1, 2, 64, 3, 128, 0.8, 1, 2)'])expect(decodeControl(text(bad),1)).toBeUndefined();
    expect(decodeControl(new Uint8Array(10),1)).toBeUndefined();
    expect(decodeControl(encodeControl({kind:'result',sender:1,trial:0,raw:{symbolErrors:2,symbols:1,bitErrors:0,bits:8,confidence:1,snrMedianDb:20,crcOk:true}}),1)).toBeUndefined();
  });
  /** A controller and partner whose packet managers exchange frames instantly, with optional losses. */
  function pair(budget=1,drop:(packet:OutgoingPacket,from:'controller'|'partner')=>boolean=()=>false){
    const events:{controller:CooperativeEvent[];partner:CooperativeEvent[]}={controller:[],partner:[]};
    const wire:{from:'controller'|'partner';packet:OutgoingPacket}[]=[];
    const managers={
      controller:new PacketManager(719,packet=>wire.push({from:'controller',packet}),{confirmed:seq=>sessions.controller.confirmed(seq),failed:(seq,body)=>sessions.controller.failed(seq,body)},3,4000,100),
      partner:new PacketManager(42,packet=>wire.push({from:'partner',packet}),{confirmed:seq=>sessions.partner.confirmed(seq),failed:(seq,body)=>sessions.partner.failed(seq,body)},3,4000,500)
    };
    const sessions={
      controller:new CooperativeSession('controller',{...config,budget},719,(body,ack)=>managers.controller.send(body,ack),e=>events.controller.push(e)),
      partner:new CooperativeSession('partner',undefined,42,(body,ack)=>managers.partner.send(body,ack),e=>events.partner.push(e))
    };
    let now=0;
    /** Delivers everything queued; each transmission takes 1 s. */
    const flush=(onTrial:(proposal:Proposal)=>void=p=>sessions.partner.measured(analyze(fixture(p)).results[0]))=>{
      for(let guard=0;wire.length&&guard<200;guard++){
        const {from,packet}=wire.shift()!,to=from==='controller'?'partner':'controller';now+=1000;
        if(packet.ackRequested)managers[from].sent(packet.seq,now);
        if(packet.body.kind==='trial')sessions.controller.trialSent(now);
        if(drop(packet,from))continue;
        if(packet.body.kind==='ack')managers[to].acked(packet.body.sender,packet.body.seq);
        else if(packet.body.kind==='control'){if(managers[to].receive(from==='controller'?719:42,packet.seq,packet.ackRequested))sessions[to].receive(packet.body.message);}
        else onTrial(packet.body.proposal);
      }
    };
    const tick=(ms:number)=>{now+=ms;for(const k of ['controller','partner'] as const){managers[k].tick(now);sessions[k].tick(now);}};
    return {managers,sessions,events,wire,flush,tick};
  }
  it('runs a trial as test_suite [ACK] → test packet → result [ACK] with sequence-numbered frames',()=>{
    const {sessions,events,wire,flush}=pair(1),kinds:string[]=[];
    sessions.partner.start(0);sessions.controller.start(0);
    const seen=wire.push.bind(wire);wire.push=(...items)=>{for(const i of items)kinds.push(`${i.from}:${i.packet.body.kind==='control'?i.packet.body.message.kind:i.packet.body.kind}${i.packet.ackRequested?'+ack':''}`);return seen(...items);};
    flush();
    expect(kinds).toEqual(['partner:ack','controller:trial','partner:result+ack','controller:ack','controller:done+ack','partner:ack']);
    expect(events.controller.filter(e=>e.kind==='feedback')).toHaveLength(1);
    expect(events.controller.some(e=>e.kind==='status'&&e.finished&&e.detail.startsWith('Search complete'))).toBe(true);
  });
  it('retransmits an unacknowledged frame with the same sequence number and delivers it once',()=>{
    let dropped=0;
    const {sessions,events,wire,flush,tick}=pair(1,(packet,from)=>from==='partner'&&packet.body.kind==='ack'&&dropped++<1);
    sessions.partner.start(0);sessions.controller.start(0);
    const suite=wire[0].packet;flush();
    // The partner's first ACK was lost: the controller hasn't sent the test packet yet.
    expect(events.controller.some(e=>e.kind==='feedback')).toBe(false);
    tick(4100);expect(wire[0].packet).toMatchObject({seq:suite.seq,attempt:1});
    flush();
    expect(events.controller.filter(e=>e.kind==='feedback')).toHaveLength(1);
    // The partner followed trial 1 once, although it heard test_suite twice.
    expect(events.partner.filter(e=>e.kind==='status'&&e.detail.startsWith('Listening for trial 1')).length).toBe(1);
  });
  it('stops after the retries when test_suite is never acknowledged',()=>{
    const {sessions,events,wire,flush,tick}=pair(1,(packet,from)=>from==='controller');
    sessions.partner.start(0);sessions.controller.start(0);
    for(let i=0;i<4;i++){flush();tick(4100);}
    expect(wire).toEqual([]);
    expect(events.controller.find(e=>e.kind==='status'&&e.finished)).toMatchObject({detail:expect.stringContaining('No ACK for test_suite')});
  });
  it('reports lost(T) when the partner never receives the test packet, and the controller re-proposes it',()=>{
    const {sessions,events,flush}=pair(2);
    sessions.partner.start(0);sessions.controller.start(0);
    flush(p=>sessions.partner.lost(p));
    const lost=events.controller.filter(e=>e.kind==='lost');
    expect(lost.length).toBeGreaterThanOrEqual(2);
    expect(lost.map(e=>e.kind==='lost'&&e.proposal.trial)).toEqual([...lost.keys()]);
    expect(events.partner.some(e=>e.kind==='status'&&e.detail.includes('not received'))).toBe(true);
  });
  it('treats a missing result as lost after the listening window and retries',()=>{
    const {sessions,events,flush,tick}=pair(1);
    sessions.partner.start(0);sessions.controller.start(0);
    flush(()=>{});// the partner hears nothing and never reports
    tick(testListenSeconds(config.trial)*1000+4*7000+1000);
    expect(events.controller.some(e=>e.kind==='lost')).toBe(true);
  });
  it('keeps a settings-free partner listening across restarted controller runs',()=>{
    const sent:ControlMessage[]=[],finished:string[]=[];let accepted=0;
    const p=new CooperativeSession('partner',undefined,0,body=>{if(body.kind==='control')sent.push(body.message);return 0;},e=>{
      if(e.kind==='status'&&e.finished)finished.push(e.detail);
      if(e.kind==='status'&&e.detail.startsWith('Listening for trial'))accepted++;
    });
    p.start(0);
    p.receive({kind:'test_suite',sender:1,trial:0,settings:config.trial});
    p.receive({kind:'test_suite',sender:1,trial:1,settings:config.trial});
    // The same controller stopped mid-run and restarted at trial 1 with different settings; no done was heard.
    p.receive({kind:'test_suite',sender:1,trial:0,settings:{...config.trial,spacing:300}});
    p.lost({sender:1,trial:0,settings:{...config.trial,spacing:300}});
    // A different controller device takes over; results for the old one are ignored.
    p.receive({kind:'test_suite',sender:2,trial:0,settings:config.trial});
    p.lost({sender:1,trial:0,settings:config.trial});
    p.receive({kind:'done',sender:1,trial:1});p.receive({kind:'done',sender:2,trial:1});
    expect(accepted).toBe(4);expect(finished).toEqual([]);
    expect(sent).toEqual([{kind:'lost',sender:0,trial:0}]);
  });
  it('runs two cooperative devices through actual acoustic decoding, ACKs included',()=>{
    const queue:{from:number;packet:OutgoingPacket}[]=[],observations:number[]=[],senders=[719,42];let now=0;
    const managers:PacketManager[]=[],sessions:CooperativeSession[]=[];
    for(let i=0;i<2;i++){
      managers.push(new PacketManager(senders[i],packet=>queue.push({from:i,packet}),{confirmed:seq=>sessions[i].confirmed(seq),failed:(seq,body)=>sessions[i].failed(seq,body)}));
      sessions.push(new CooperativeSession(i===0?'controller':'partner',i===0?{...config,budget:2}:undefined,senders[i],(body,ack)=>managers[i].send(body,ack),
        e=>{if(e.kind==='feedback')observations.push(e.observation.raw.bitErrors);}));
    }
    const analyzers=[0,1].map(i=>new CooperativeAnalyzer(rate,{self:senders[i],analyze:i===1,
      control:(m,frame)=>{if(managers[i].receive(m.sender,frame.seq,frame.ackRequested))sessions[i].receive(m);},
      ack:(_from,target)=>managers[i].acked(target.sender,target.seq),
      measurement:m=>sessions[i].measured(m),testHeard:p=>sessions[i].testHeard(p),lost:p=>sessions[i].lost(p)}));
    sessions[1].start(now);sessions[0].start(now);
    let bursts=0;
    for(let count=0;queue.length&&count<40;count++){
      const {from,packet}=queue.shift()!,{body}=packet;if(body.kind==='trial')bursts++;
      const wave=guardedWave(body.kind==='control'?controlWave(body.message,rate,packet.seq,packet.ackRequested)
        :body.kind==='trial'?trialWave(body.proposal,rate,packet.seq):ackWave(senders[from],packet.seq,body.sender,body.seq,rate),rate);
      const noisy=simulateChannel(wave,{snrDb:25,seed:count+15});
      for(let offset=0;offset<wave.length;offset+=128)for(let i=0;i<2;i++)analyzers[i].push((i===from?wave:noisy).subarray(offset,offset+128));
      now+=wave.length/rate*1000;
      if(packet.ackRequested)managers[from].sent(packet.seq,now);
      if(body.kind==='trial')sessions[0].trialSent(now);
    }
    expect(observations).toEqual([0,0]);expect(bursts).toBe(2);expect(queue).toHaveLength(0);
  });
  it('logs each frame identically on both devices, -> where it was sent and <- where it was received',()=>{
    const suite:ControlMessage={kind:'test_suite',...proposal},result:ControlMessage={kind:'result',sender:42,trial:0,raw:{symbolErrors:1,symbols:64,bitErrors:1,bits:128,confidence:0.9,snrMedianDb:12.5,crcOk:true}};
    const waves=[guardedWave(controlWave(suite,rate,5,true),rate),guardedWave(ackWave(42,8,719,5,rate),rate),guardedWave(trialWave(proposal,rate,6),rate),
      guardedWave(controlWave(result,rate,9,true),rate)];
    const samples=new Float32Array(waves.reduce((n,w)=>n+w.length,0)+Math.ceil(testListenSeconds(config.trial)*rate));
    let at=0;for(const w of waves){samples.set(w,at);at+=w.length;}
    // What each sender's worker logs as it transmits (the same helpers, with the arrow reversed).
    const sent=[`-> ${describeWire(suite,5)}`,'-> 002A#8 ACK 02CF#5',`-> ${describeTestSent(proposal,6)}`,`-> ${describeWire(result,9)}`];
    const received=analyze(samples).lines;
    expect(received[0]).toBe(sent[0].replace('->','<-'));
    expect(received[1]).toBe(sent[1].replace('->','<-'));
    expect(received[2].startsWith(sent[2].replace('->','<-'))).toBe(true);
    expect(received[3]).toBe(sent[3].replace('->','<-'));
  });
  it('reports corrupted control messages',()=>{
    const bad=guardedWave(controlWave({kind:'lost',sender:42,trial:0},rate,7,true),rate);const tail=Math.round(bad.length*0.55);bad.fill(0,tail,tail+Math.round(rate*0.08));
    const samples=new Float32Array(bad.length+fixture().length);samples.set(bad);samples.set(fixture(),bad.length);
    const {lines,results}=analyze(samples);
    const errors=lines.filter(l=>l.startsWith('X'));
    expect(errors).toHaveLength(1);expect(errors[0]).toMatch(/^X Garbled message "[^"]*" \[[0-9A-F ]+\] \((CRC failed|signal lost after \d+ of \d+ bytes)\)$/);
    expect(results).toHaveLength(1);
  });
  it('logs every received frame with its sender#seq, raw then decoded, with per-symbol S/N for the test packet',()=>{
    const done=guardedWave(controlWave({kind:'done',sender:719,trial:1},rate,9,true),rate),ack=guardedWave(ackWave(719,10,42,3,rate),rate);
    const base=fixture(),samples=new Float32Array(base.length+done.length+ack.length);
    samples.set(base);samples.set(done,base.length);samples.set(ack,base.length+done.length);
    const acks:{from:number;target:{sender:number;seq:number}}[]=[];
    const {lines}=analyze(samples,{ack:(from,target)=>acks.push({from,target})});
    const payload=hexBytes(trialPayload(validateTrial(config.trial)));
    expect(lines[0]).toBe('<- 02CF#0 test_suite(1, 1000, 200, 4, 100, 16, 719) · trial 1 settings: Base=1000, Delta=200, Tones=4, Baud=100, Bytes=16, Seed=719');
    // This default test uses the control tones and baud, so the control listener also decodes the packet; it is logged once, scored.
    expect(lines[1]).toMatch(new RegExp(`^<- 02CF#0 test packet ${payload.replace(/[[\]]/g,'\\$&')} · trial 1: received, 64/64 symbols received, S/N dB \\[(-?\\d+ ){63}-?\\d+\\] median \\d+\\.\\d · drift [+−]\\d+\\.\\d ms$`));
    expect(lines.slice(2)).toEqual(['<- 02CF#9 done(1) · run finished after 1 trials','<- 02CF#10 ACK 002A#3']);
    expect(acks).toEqual([{from:719,target:{sender:42,seq:3}}]);
    // The controller hears its own transmissions: dropped unlogged, before the session sees them.
    const heard:ControlMessage[]=[],controller=analyze(samples,{analyze:false,control:m=>heard.push(m),self:719});
    expect(controller.lines).toEqual([]);expect(heard).toEqual([]);
    expect(describeControl({kind:'result',sender:1,trial:2,raw:{symbolErrors:3,symbols:64,bitErrors:4,bits:128,confidence:1,snrMedianDb:18.26,crcOk:false}})).toBe('trial 3: CRC failed, 61/64 symbols received, median S/N 18.3 dB');
    expect(hexBytes([0x1a,0xef,5])).toBe('[1A EF 05]');
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
