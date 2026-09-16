import { simulateChannel } from './channel';
import { describe, expect, it } from 'vitest';
import { ackWave, CooperativeAnalyzer, controlWave, guardedWave, trialWave, type AnalyzerOptions } from './experiment';
import { TRANSMIT_AMPLITUDE, CONTROL_FSK, SEARCH_PARAMETERS, searchParameterPlan, MAX_REPETITIONS, estimateRunSeconds, searchValues, totalTests, withValue, trialFsk as trialFskOf, controlText, describeTestSent, describeWire, estimateTestSeconds, testListenSeconds, testSymbolCount, trialFsk, defaultSearch, describeControl, hexBytes, trialPayload, validateSearch, validateTrial, encodeControl, decodeControl, ParameterSearch, type Proposal, type TrialMeasurement, type ControlMessage, type CooperativeEvent } from '../experiment';
import { CooperativeSession } from '../cooperative-session';
import { ACK_TIMEOUT_MS, DEFAULT_RETRIES, PacketManager, type OutgoingPacket } from '../packet-manager';
import { PAYLOAD_OFFSET } from './frame';
import { fskPlanWarnings } from './fsk-frequencies';
/** The rate every device in the field has reported. A lower fixture rate once could not even carry the control band. */
const rate=48000,config=validateSearch(defaultSearch()),proposal={sender:719,trial:0,settings:config.trial};
/** test_suite, then the test packet as an ordinary guarded frame, then enough quiet for the listener window to close. */
export function fixture(p:Proposal=proposal,sampleRate=rate) {
  const a=guardedWave(controlWave({kind:'test_suite',...p},sampleRate),sampleRate),b=guardedWave(trialWave(p,sampleRate),sampleRate);
  const out=new Float32Array(a.length+b.length+Math.ceil(testListenSeconds(p.settings)*sampleRate));out.set(a);out.set(b,a.length);return out;
}
/** Sample index where the fixture's test packet frame starts. */
const packetStart=(sampleRate=rate)=>guardedWave(controlWave({kind:'test_suite',...proposal},sampleRate),sampleRate).length+sampleRate/2;
function analyze(samples:Float32Array,options:AnalyzerOptions={},sampleRate=rate) {
  const results:TrialMeasurement[]=[],lost:Proposal[]=[],lines:string[]=[];
  const analyzer=new CooperativeAnalyzer(sampleRate,{analyze:true,measurement:r=>results.push(r),lost:p=>lost.push(p),wire:l=>lines.push(l),...options});
  for(let i=0;i<samples.length;i+=128)analyzer.push(samples.subarray(i,i+128));
  return {results,lost,lines};
}
const perSymbol=rate/config.trial.symbolRate;
/** One value in the sweep, so `repetitions` alone sets how many tests a run sends. */
const single={...config,minimum:1000,maximum:1001,step:400};
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
    for(let i=from;i<from+12*perSymbol;i++)samples[i]=2*TRANSMIT_AMPLITUDE*Math.sin(2*Math.PI*wrong*i/rate);
    const {results,lost}=analyze(samples);
    expect(lost).toEqual([]);expect(results).toHaveLength(1);
    expect(results[0].raw.crcOk).toBe(false);expect(results[0].raw.symbolErrors).toBeGreaterThan(4);
  });
  it('keeps positions true when captured audio never reaches the decoder',()=>{
    // The main thread drops whole capture chunks when the worker lags. Splicing across that loss would put every
    // later position out of step with the recording the operator is comparing against.
    const samples=fixture(),cut=Math.round(rate*0.1),at=packetStart()-Math.round(rate*0.25);
    const results:TrialMeasurement[]=[],lines:string[]=[];
    const analyzer=new CooperativeAnalyzer(rate,{analyze:true,measurement:r=>results.push(r),wire:l=>lines.push(l)});
    for(let i=0;i<at;i+=128)analyzer.push(samples.subarray(i,Math.min(at,i+128)));
    analyzer.gap(cut);
    for(let i=at+cut;i<samples.length;i+=128)analyzer.push(samples.subarray(i,i+128));
    expect(results).toHaveLength(1);
    expect(results[0].raw.crcOk).toBe(true);
    expect(Math.abs(results[0].startPosition-packetStart())).toBeLessThanOrEqual(2);
    expect(lines.some(l=>l.startsWith('X Capture gap'))).toBe(true);
  });
  it('reports a control sync it can hear but cannot read, instead of nothing',()=>{
    // Six of the sixteen sync windows get a competing tone just loud enough to win: the matched filter still fires
    // unmistakably, but too many symbols misread for the frame to be worth decoding. Before this, such a frame left
    // no trace at all; a partner two feet from a phone on a desk saw an empty log.
    const samples=fixture(),start=rate/2,spp=rate/25,F=CONTROL_FSK.frequencies;
    const template=[0,1,2,2,3,0,3,3,3,3,3,0,0,1,3,1];
    for(const index of [1,3,5,7,9,13]){
      const wrong=(template[index]+1)%4;
      for(let i=0;i<spp;i++)samples[start+index*spp+i]+=0.88*Math.sin(2*Math.PI*F[wrong]*i/rate);
    }
    const {results,lost,lines}=analyze(samples);
    expect(results).toEqual([]);expect(lost).toEqual([]);
    expect(lines.some(l=>l.startsWith('X Frame sync heard but 6 of 16 sync symbols misread'))).toBe(true);
  });
  it('keeps the control link above a phone speaker\'s far-field rolloff, harmonic-free, within an octave',()=>{
    // Two feet from a phone on a desk, 2900 Hz arrived 14 dB louder than 1500 Hz and only the high tones decoded.
    const tones=CONTROL_FSK.frequencies;
    expect(tones[0]).toBeGreaterThanOrEqual(2800);
    expect(tones[tones.length-1]).toBeLessThanOrEqual(6000);
    expect(tones[tones.length-1]/tones[0]).toBeLessThan(2);
    expect(fskPlanWarnings(tones,CONTROL_FSK.symbolRate)).toEqual([]);
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
    // 40 ms symbols at 25 baud drift further in milliseconds than the 10 ms symbols this once used.
    expect(results[0].timingDriftMs).toBeGreaterThan(0.2);expect(results[0].timingDriftMs).toBeLessThan(5);
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
    const counts=(m:TrialMeasurement)=>({...m.raw,confidence:Math.round(m.raw.confidence*1000)});
    expect(counts(late)).toEqual(counts(early));expect(late.startPosition).toBe(early.startPosition+quiet);
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
  // Eight and sixteen tones spread past 4 kHz, so these run at a real device's sample rate.
  it.each([2,4,8,16])('measures %i tones with payload-only bit counts',tones=>{
    const sampleRate=48_000;
    const p={...proposal,settings:validateTrial({...proposal.settings,tones,lowestFrequency:1500})};
    const {results}=analyze(fixture(p,sampleRate),{},sampleRate);
    expect(results).toHaveLength(1);expect(results[0].raw.bits).toBe(128);expect(results[0].raw.bitErrors).toBe(0);
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
    expect(controlText({kind:'test_suite',sender:0x1a2b,trial:0,settings:validateTrial(config.trial)})).toBe('test_suite(1, 1500, 4, 25, 16, 719, 40)');
    expect(controlText({kind:'result',sender:0x1a2b,trial:0,raw:{symbolErrors:2,symbols:64,bitErrors:3,bits:128,confidence:0.8234,snrMedianDb:-3.26,crcOk:false}})).toBe('result(1, 2, 64, 3, 128, 0.82, -3.3, 0)');
    expect(controlText({kind:'done',sender:0x1a2b,trial:8})).toBe('done(8)');
    expect(decodeControl(text('lost(4)'),0x1a2b)).toEqual({kind:'lost',sender:0x1a2b,trial:3});
    expect(decodeControl(text('done(8)'),0x1a2b)).toEqual({kind:'done',sender:0x1a2b,trial:8});
    for(const bad of ['lost()','lost(0)','hello(1)','lost(1','ready(1)','ack(1)','query(1)','lost(x)','lost(1, 2)','result(1, 2, 64, 3, 128, 0.8, 1, 2)'])expect(decodeControl(text(bad),1)).toBeUndefined();
    expect(decodeControl(new Uint8Array(10),1)).toBeUndefined();
    expect(decodeControl(encodeControl({kind:'result',sender:1,trial:0,raw:{symbolErrors:2,symbols:1,bitErrors:0,bits:8,confidence:1,snrMedianDb:20,crcOk:true}}),1)).toBeUndefined();
  });
  /** A controller and partner whose packet managers exchange frames instantly, with optional losses. */
  function pair(repetitions=1,drop:(packet:OutgoingPacket,from:'controller'|'partner')=>boolean=()=>false){
    const events:{controller:CooperativeEvent[];partner:CooperativeEvent[]}={controller:[],partner:[]};
    const wire:{from:'controller'|'partner';packet:OutgoingPacket}[]=[];
    const managers={
      controller:new PacketManager(719,packet=>wire.push({from:'controller',packet}),{confirmed:seq=>sessions.controller.confirmed(seq),failed:(seq,body)=>sessions.controller.failed(seq,body)},3,4000,100),
      partner:new PacketManager(42,packet=>wire.push({from:'partner',packet}),{confirmed:seq=>sessions.partner.confirmed(seq),failed:(seq,body)=>sessions.partner.failed(seq,body)},3,4000,500)
    };
    const sessions={
      controller:new CooperativeSession('controller',{...single,repetitions},719,(body,ack)=>managers.controller.send(body,ack),e=>events.controller.push(e)),
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
    // The controller waits out the listening window plus every ACK retry before calling the trial lost.
    tick(testListenSeconds(config.trial)*1000+(DEFAULT_RETRIES+1)*(ACK_TIMEOUT_MS+3000)+1000);
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
    p.receive({kind:'test_suite',sender:1,trial:0,settings:{...config.trial,tones:8}});
    p.lost({sender:1,trial:0,settings:{...config.trial,tones:8}});
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
      sessions.push(new CooperativeSession(i===0?'controller':'partner',i===0?{...single,repetitions:2}:undefined,senders[i],(body,ack)=>managers[i].send(body,ack),
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
    expect(lines[0]).toBe('<- 02CF#0 test_suite(1, 1500, 4, 25, 16, 719, 40) · trial 1 settings: Base=1500, Tones=4, Baud=25, Bytes=16, Seed=719, Amp=40% (1500/1700/2100/2900 Hz)');
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
    // 25-baud control messages are slow: a clean test runs well over half a minute.
    const seconds=estimateTestSeconds(validateTrial(config.trial));
    expect(seconds).toBeGreaterThan(25);expect(seconds).toBeLessThan(60);
    expect(estimateTestSeconds(validateTrial({...config.trial,payloadBytes:64}))).toBeGreaterThan(seconds+5);
    expect(trialFsk(validateTrial(config.trial)).amplitude).toBe(TRANSMIT_AMPLITUDE);
    expect(()=>validateSearch({...config,repetitions:MAX_REPETITIONS+1})).toThrow('repetitions');
    expect(()=>validateSearch({...config,step:1,repetitions:50})).toThrow('at most 200 test packets');
  });
  it('accepts a run on every parameter it offers, each with its own default range',()=>{
    // The parameter list and the validator's check were once separate, and amplitude was added to one but not the
    // other: every amplitude run failed as an invalid range. Walk the whole list so that cannot recur.
    for(const p of SEARCH_PARAMETERS){
      const run={...config,parameter:p.key,minimum:p.minimum,maximum:p.maximum,step:p.step};
      expect(()=>validateSearch(run)).not.toThrow();
      expect(searchValues(run).length).toBeGreaterThan(1);
      expect(searchParameterPlan(p.key)).toBe(p);
    }
    expect(()=>validateSearch({...config,parameter:'nonsense' as never})).toThrow();
  });
  it('sweeps test amplitude, carries it on the wire, and still reads messages sent before it existed',()=>{
    expect(searchValues({...config,parameter:'amplitudePercent',minimum:20,maximum:80,step:20})).toEqual([20,40,60,80]);
    expect(trialFsk(withValue(config.trial,'amplitudePercent',20)).amplitude).toBeCloseTo(0.2);
    expect(trialFsk(withValue(config.trial,'amplitudePercent',100)).amplitude).toBeCloseTo(1);
    // Only test packets vary: sweeping the level must not make the control link itself unreliable.
    expect(CONTROL_FSK.amplitude).toBe(TRANSMIT_AMPLITUDE);
    // The amplitude is required, not optional: a test_suite without it is rejected rather than guessed at.
    expect(decodeControl(new TextEncoder().encode('test_suite(1, 1500, 4, 25, 16, 719)'),0x1a2b)).toBeUndefined();
    expect(()=>validateTrial({...config.trial,amplitudePercent:0})).toThrow();
    expect(()=>validateTrial({...config.trial,amplitudePercent:101})).toThrow();
    expect(()=>validateTrial({...config.trial,amplitudePercent:42.5})).toThrow();
    const {amplitudePercent:_omitted,...missing}=config.trial;
    expect(()=>validateTrial(missing)).toThrow();
    expect(()=>validateTrial(undefined)).toThrow();
  });
  it('covers every value equally in a shuffled order, and picks the best measured one',()=>{
    // Deterministic shuffling keeps the test stable; the schedule still covers each value once per repetition.
    let seed=7;const random=()=>((seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff);
    const run={...config,minimum:600,maximum:3000,step:400,repetitions:3},values=searchValues(run);
    expect(values).toEqual([600,1000,1400,1800,2200,2600,3000]);
    expect(totalTests(run)).toBe(21);
    const s=new ParameterSearch(run,random),order:number[]=[];
    for(let i=0;i<21;i++){
      const settings=s.next()!;order.push(settings.lowestFrequency);
      s.add({sender:1,trial:i,settings,raw:{symbolErrors:settings.lowestFrequency===1400?0:10,symbols:64,bits:128,bitErrors:10,confidence:.8,snrMedianDb:20,crcOk:true}});
    }
    expect(s.next()).toBeUndefined();
    for(const value of values)expect(order.filter(v=>v===value)).toHaveLength(3);
    // Each repetition is a full pass, and at least one pass is not in ascending order.
    for(let pass=0;pass<3;pass++)expect([...order.slice(pass*7,pass*7+7)].sort((a,b)=>a-b)).toEqual(values);
    expect(order.slice(0,7)).not.toEqual(values);
    expect(s.best()?.value).toBe(1400);
    expect(s.add(s.observations[0])).toBe(false);
  });
  it('sweeps test baud, setting each value its own orthogonal tone spacing',()=>{
    const run=validateSearch({...config,parameter:'symbolRate',minimum:25,maximum:100,step:25,repetitions:1});
    expect(searchValues(run)).toEqual([25,50,75,100]);
    const s=new ParameterSearch(run,()=>0),seen:[number,number][]=[];
    for(let i=0;i<4;i++){
      const settings=s.next()!;seen.push([settings.symbolRate,trialFskOf(settings).frequencies[1]-settings.lowestFrequency]);
      s.add({sender:1,trial:i,settings,raw:{symbolErrors:0,symbols:64,bits:128,bitErrors:0,confidence:1,snrMedianDb:20,crcOk:true}});
    }
    // Each baud gets its own tone plan, with gaps that are multiples of that baud.
    expect(seen.sort((a,b)=>a[0]-b[0]).map(([baud,gap])=>[baud,gap%baud])).toEqual([[25,0],[50,0],[75,0],[100,0]]);
    // Slower tests take longer, so the run estimate adds each value's own air time.
    const slow=estimateTestSeconds(withValue(config.trial,'symbolRate',25));
    const fast=estimateTestSeconds(withValue(config.trial,'symbolRate',100));
    expect(slow).toBeGreaterThan(fast);
    expect(estimateRunSeconds(run)).toBeCloseTo([25,50,75,100].reduce((t,v)=>t+estimateTestSeconds(withValue(config.trial,'symbolRate',v)),0),6);
  });
  it('re-sends the same value when a trial is never received, keeping coverage exact',()=>{
    const run={...config,minimum:600,maximum:1400,step:400,repetitions:1};
    const s=new ParameterSearch(run,()=>0);
    const first=s.next()!;
    expect(s.next()).toEqual(first); // nothing recorded yet, so the same value comes up again
    s.add({sender:1,trial:0,settings:first,raw:{symbolErrors:0,symbols:64,bits:128,bitErrors:0,confidence:1,snrMedianDb:20,crcOk:true}});
    expect(s.next()).not.toEqual(first);
  });
});
