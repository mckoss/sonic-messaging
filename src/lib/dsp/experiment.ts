import { CONTROL_FSK, decodeControl, encodeControl, trialFsk, trialPayload, validateTrial,
  type Proposal, type ControlMessage, type TrialMeasurement, type AcquisitionResult } from '../experiment';
import { encodeFsk } from './fsk';
import { FskStreamDecoder } from './fsk-stream';
import { detectFskSymbol } from './fsk-detector';
import { bytesToBits } from './bits';
import { frame } from './frame';

export function controlWave(message:ControlMessage,sampleRate:number):Float32Array {
  return encodeFsk(encodeControl(message),{...CONTROL_FSK,sampleRate}).samples;
}
export function trialLayout(proposal:Proposal,sampleRate:number){
  const t=validateTrial(proposal.settings);
  if(trialFsk(t).frequencies.slice(-1)[0]>=sampleRate/2)throw new Error('Test tones exceed the audio sample rate');
  const startMarker=controlWave({kind:'start',session:proposal.session,trial:proposal.trial,sampleRate},sampleRate).length;
  const guard=Math.round(t.guardSeconds*sampleRate),perSymbol=Math.round(sampleRate/t.symbolRate);
  const testSymbols=Math.ceil((t.payloadBytes+9)*8/Math.log2(t.tones));
  const testStart=startMarker+guard,testEnd=testStart+testSymbols*perSymbol,endMarker=testEnd+guard;
  return {startMarker,guard,perSymbol,testStart,testEnd,endMarker};
}
export function trialWave(proposal:Proposal,sampleRate:number):Float32Array {
  const layout=trialLayout(proposal,sampleRate),end=controlWave({kind:'end',session:proposal.session,trial:proposal.trial},sampleRate);
  const out=new Float32Array(layout.endMarker+end.length);
  out.set(controlWave({kind:'start',session:proposal.session,trial:proposal.trial,sampleRate},sampleRate));
  out.set(encodeFsk(trialPayload(proposal.settings),{...trialFsk(proposal.settings),sampleRate}).samples,layout.testStart);
  out.set(end,layout.endMarker);return out;
}
/** Guard every outgoing exchange; a trial's markers/test are one sample-timed waveform. */
export function guardedWave(samples:Float32Array,sampleRate:number):Float32Array {
  const guard=Math.round(sampleRate*0.5),out=new Float32Array(samples.length+guard*2);out.set(samples,guard);return out;
}

/** Known alignment comes solely from the control markers, never the test packet's sync. */
export function measureTrial(samples:Float32Array,sampleRate:number,proposal:Proposal,startMarker:number,endMarker:number,transmitterRate:number):TrialMeasurement {
  const t=proposal.settings,layout=trialLayout(proposal,transmitterRate),scale=(endMarker-startMarker)/layout.endMarker;
  if(Math.abs(scale*transmitterRate/sampleRate-1)>0.01)throw new Error('Control timing markers disagree by more than 1%; trial is not scored');
  const start=startMarker+layout.testStart*scale,end=startMarker+layout.testEnd*scale,perSymbol=layout.perSymbol*scale;
  if(start<0||end>samples.length)throw new Error('Incomplete trial capture');
  const expected=bytesToBits(frame(trialPayload(t))),bps=Math.log2(t.tones),symbolCount=Math.ceil(expected.length/bps);
  const confusion=Array.from({length:t.tones},()=>Array(t.tones).fill(0) as number[]);
  const raw={symbolErrors:0,symbols:0,bitErrors:0,bits:0,confidence:0};
  for(let s=0;s<symbolCount;s++){
    const from=Math.round(start+s*perSymbol),to=Math.round(start+(s+1)*perSymbol);
    const decision=detectFskSymbol(samples.subarray(from,to),sampleRate,trialFsk(t).frequencies);
    let winner=0;for(let i=1;i<t.tones;i++)if(decision.scores[i]>decision.scores[winner])winner=i;
    let target=0;
    for(let b=0;b<bps;b++){
      const bit=s*bps+b;target=(target<<1)|(expected[bit]??0);
      if(bit>=56&&bit<56+t.payloadBytes*8){raw.bits++;if(((winner>>>(bps-b-1))&1)!==expected[bit])raw.bitErrors++;}
    }
    if(s*bps>=56&&(s+1)*bps<=56+t.payloadBytes*8){raw.symbols++;raw.symbolErrors+=winner===target?0:1;confusion[target][winner]++;raw.confidence+=decision.confidence;}
  }
  raw.confidence/=Math.max(1,raw.symbols);
  const measurement:TrialMeasurement={...proposal,raw,sampleRate,testStart:start,testEnd:end,samplesPerSymbol:perSymbol,startMarker,endMarker,confusion,acquisition:[]};
  measurement.acquisition=replayAcquisition(samples,measurement);
  return measurement;
}
/** Crop only on the receiver. Fresh decoders never receive ground-truth packet positions. */
export function replayAcquisition(samples:Float32Array,m:TrialMeasurement):AcquisitionResult[]{
  const t=m.settings,lead=t.guardSeconds*m.sampleRate*0.8;
  return [0,0.25,1.5,2.75].map(symbolOffset=>{
    const advance=Math.min(symbolOffset*m.samplesPerSymbol,lead*0.75);
    const from=Math.max(0,Math.floor(m.testStart-lead+advance)),to=Math.min(samples.length,Math.ceil(m.testEnd+t.guardSeconds*m.sampleRate*0.5));
    const decoder=new FskStreamDecoder({...trialFsk(t),sampleRate:m.sampleRate});
    const packets=[],progress=[];
    for(let offset=from;offset<to;offset+=128){packets.push(...decoder.push(samples.subarray(offset,Math.min(to,offset+128))));progress.push(...decoder.drainProgress());}
    const packet=packets.find(p=>Math.abs(p.startPosition+from-m.testStart)<m.samplesPerSymbol/2);
    const expected=trialPayload(t);
    const acquired=progress.some(p=>p.type==='sync'&&Math.abs(p.position+from-32*Math.round(m.sampleRate/t.symbolRate)/Math.log2(t.tones)-m.testStart)<m.samplesPerSymbol/2);
    return {offsetSamples:from,acquired,crcOk:!!packet,exact:!!packet&&packet.payload.length===expected.length&&packet.payload.every((b,i)=>b===expected[i])};
  });
}

/** Retains the real channel, quiet intervals and control conversation for repeatable analysis. */
export class CooperativeAnalyzer {
  private buffer:Float32Array;
  private length=0;
  private decoder:FskStreamDecoder;
  private proposals=new Map<string,Proposal>();
  private starts=new Map<string,{position:number;rate:number}>();
  private measured=new Set<string>();
  constructor(readonly sampleRate:number,private control:(m:ControlMessage)=>void,
    private measurement:(m:TrialMeasurement)=>void,private problem:(message:string)=>void,private analyze=true,
    private controlError:(message:string)=>void=()=>{}){
    this.buffer=new Float32Array(sampleRate*120);this.decoder=new FskStreamDecoder({...CONTROL_FSK,sampleRate});
  }
  push(chunk:Float32Array){
    if(this.length+chunk.length>this.buffer.length)return;
    this.buffer.set(chunk,this.length);this.length+=chunk.length;
    for(const packet of this.decoder.push(chunk)){
      // A valid frame that isn't control is usually test data sent on the control tones.
      const m=decodeControl(packet.payload);if(!m)continue;
      const key=`${m.session}:${m.trial}`;
      if(this.analyze){
        if(m.kind==='propose'&&!this.proposals.has(key)&&this.proposals.size<16)this.proposals.set(key,{session:m.session,trial:m.trial,settings:m.settings});
        if(m.kind==='start'&&this.proposals.has(key)&&!this.starts.has(key))this.starts.set(key,{position:packet.startPosition,rate:m.sampleRate});
        if(m.kind==='end'&&!this.measured.has(key)){
          const p=this.proposals.get(key),start=this.starts.get(key);
          if(!p||!start){
            this.measured.add(key);
            this.problem(`Trial ${m.trial+1}: end marker heard but the ${p?'start marker':'proposal'} was missed; not scored.`);
          }else{
            this.measured.add(key);
            try{this.measurement(measureTrial(this.buffer.subarray(0,this.length),this.sampleRate,p,start.position,packet.startPosition,start.rate));}
            catch(e){this.problem(e instanceof Error?e.message:String(e));}
          }
        }
      }
      this.control(m);
    }
    // The control payload has CRC but no FEC, so any symbol error discards the whole message.
    for(const p of this.decoder.drainProgress())if(p.type==='crc-error')this.controlError('Control message heard but corrupted (CRC failed); waiting for a retry.');
  }
}
