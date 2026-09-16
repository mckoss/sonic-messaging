import { CONTROL_FSK, controlAddress, decodeControl, describeTestReceived, describeWire, encodeControl, hexBytes, median, snrDbFromScore,
  testListenSeconds, trialFsk, trialPayload, type ControlMessage, type Proposal, type TrialMeasurement } from '../experiment';
import { encodeFsk } from './fsk';
import { FskStreamDecoder, type FskStreamFrame, type FskStreamProgress } from './fsk-stream';
import { bytesToBits } from './bits';
import { decodeAck, encodeAck, FRAME_TYPE, FRAME_TYPE_NAMES, frame, frameId, PAYLOAD_OFFSET } from './frame';

export function controlWave(message:ControlMessage,sampleRate:number,seq=0,ackRequested=false):Float32Array {
  return encodeFsk(encodeControl(message),{...CONTROL_FSK,sampleRate,address:controlAddress(message,seq,ackRequested)}).samples;
}
/** An ACK frame from `sender` confirming `target#targetSeq`, on the control settings. */
export function ackWave(sender:number,seq:number,target:number,targetSeq:number,sampleRate:number):Float32Array {
  return encodeFsk(encodeAck(target,targetSeq),{...CONTROL_FSK,sampleRate,address:{sender,seq,type:FRAME_TYPE.ack}}).samples;
}
/** A trial's test packet is an ordinary frame of type test on the trial's settings; nothing else marks it. */
export function trialWave(proposal:Proposal,sampleRate:number,seq=0):Float32Array {
  if(trialFsk(proposal.settings).frequencies.slice(-1)[0]>=sampleRate/2)throw new Error('Test tones exceed the audio sample rate');
  const address={sender:proposal.sender,seq,type:FRAME_TYPE.test};
  return encodeFsk(trialPayload(proposal.settings),{...trialFsk(proposal.settings),sampleRate,address}).samples;
}
/** Guard every outgoing exchange with quiet; before a test packet this is the only (unannounced) delay. */
export function guardedWave(samples:Float32Array,sampleRate:number):Float32Array {
  const guard=Math.round(sampleRate*0.5),out=new Float32Array(samples.length+guard*2);out.set(samples,guard);return out;
}

/**
 * Scores what the ordinary receiver decoded for a trial's test packet, CRC-valid or not, against the known payload.
 * Returns undefined when the frame can't be this trial's packet (wrong length).
 */
export function scoreTestFrame(proposal:Proposal,received:FskStreamFrame,sampleRate:number):TrialMeasurement|undefined{
  const t=proposal.settings;
  if(received.payloadLength!==t.payloadBytes)return;
  const expected=bytesToBits(frame(trialPayload(t),{sender:proposal.sender,type:FRAME_TYPE.test})),bps=Math.log2(t.tones);
  const header=PAYLOAD_OFFSET*8,payloadBits=t.payloadBytes*8;
  const confusion=Array.from({length:t.tones},()=>Array(t.tones).fill(0) as number[]);
  const raw={symbolErrors:0,symbols:0,bitErrors:0,bits:0,confidence:received.confidence,snrMedianDb:0,crcOk:received.crcOk};
  const bits:number[]=[],snrDb:number[]=[];
  received.symbols.forEach((winner,s)=>{
    let target=0;
    for(let b=0;b<bps;b++){
      const bit=s*bps+b;target=(target<<1)|(expected[bit]??0);
      if(bit>=header&&bit<header+payloadBits){const heard=(winner>>>(bps-b-1))&1;bits.push(heard);raw.bits++;if(heard!==expected[bit])raw.bitErrors++;}
    }
    if(s*bps>=header&&(s+1)*bps<=header+payloadBits){
      raw.symbols++;raw.symbolErrors+=winner===target?0:1;confusion[target][winner]++;snrDb.push(snrDbFromScore(received.scores[s]));
    }
  });
  raw.snrMedianDb=median(snrDb);
  const bytes=Array.from({length:t.payloadBytes},(_,i)=>bits.slice(i*8,i*8+8).reduce((byte,b)=>(byte<<1)|b,0));
  return {...proposal,seq:received.seq,received:bytes,snrDb,raw,sampleRate,startPosition:received.startPosition,
    timingDriftMs:received.timingOffset/sampleRate*1000,confusion};
}

export interface AnalyzerOptions {
  /** A control message, with its frame's sequence number and ACK request. */
  control?:(m:ControlMessage,frame:{seq:number;ackRequested:boolean})=>void;
  /** An ACK frame from `from` confirming `target#seq`. */
  ack?:(from:number,target:{sender:number;seq:number})=>void;
  measurement?:(m:TrialMeasurement)=>void;
  /** The expected test packet's sync was heard; the trial is on the air. */
  testHeard?:(proposal:Proposal)=>void;
  /** No test packet was heard before the listening window closed. */
  lost?:(proposal:Proposal)=>void;
  wire?:(line:string)=>void;
  /** Listen for test packets after each test_suite (partner and replay). */
  analyze?:boolean;
  /** This device's sender ID; its own frames heard back are dropped unlogged. */
  self?:number;
}

/** What it took to read a frame, when it took anything: worth seeing in the log, because it measures the margin left. */
const recovery=(p:{echoCancelled?:boolean;softCorrected?:number})=>
  [p.echoCancelled?'echo cancelled':'',p.softCorrected?`recovered ${p.softCorrected} weak symbol${p.softCorrected>1?'s':''}`:'']
    .filter(Boolean).map(note=>` · ${note}`).join('');

/** Tracks the bytes of a frame in progress so a failed one can be logged with what was heard. */
class GarbleTracker {
  private bytes:number[]=[];
  private length?:number;
  constructor(private wire:(line:string)=>void,private label:()=>string){}
  observe(progress:FskStreamProgress[]){
    for(const p of progress){
      if(p.type==='sync'||p.type==='crc-confirm'){this.bytes=[];this.length=undefined;}
      else if(p.type==='length')this.length=p.length;
      else if(p.type==='byte')this.bytes.push(p.byte);
      else if(p.type==='crc-error'){
        const text=String.fromCharCode(...this.bytes.map(b=>b>=0x20&&b<=0x7e?b:0xb7));
        const heard=this.bytes.length?` "${text}" ${hexBytes(this.bytes)}`:'';
        const why=this.length===undefined?'header unreadable':this.bytes.length<this.length?`signal lost after ${this.bytes.length} of ${this.length} bytes`:'CRC failed';
        this.wire(`X Garbled ${this.label()}${heard} (${why})`);
        this.bytes=[];this.length=undefined;
      }
    }
  }
}

/**
 * Two listeners share the incoming audio. The control listener always runs. After each test_suite, a temporary
 * listener on the trial's own settings receives the test packet exactly as ordinary reception would, until the packet
 * is decoded or the expected listening window closes. Memory stays bounded however long the session runs.
 */
export class CooperativeAnalyzer {
  private position=0;
  private control:FskStreamDecoder;
  private controlGarble:GarbleTracker;
  private test?:{proposal:Proposal;decoder:FskStreamDecoder;deadline:number;heard:boolean;garbled:boolean};
  private wire:(line:string)=>void;
  constructor(readonly sampleRate:number,private options:AnalyzerOptions={}){
    this.wire=options.wire??(()=>{});
    this.control=new FskStreamDecoder({...CONTROL_FSK,sampleRate});
    this.controlGarble=new GarbleTracker(this.wire,()=>'message');
  }
  /**
   * True while a control frame is actually being received: its sync has been verified and its symbols are being read.
   * Starting a transmission now would talk over the rest of it and lose both frames, so the sender waits. Sync alone
   * is the right test — it is only 0.6 s into a frame that may run for nine seconds, and it has already been checked
   * symbol by symbol, so it does not fire on room noise.
   */
  get receiving():boolean{return this.control.lockedSymbolAnchor()!==undefined;}
  push(chunk:Float32Array){
    for(const packet of this.control.push(chunk)){
      if(packet.sender===this.options.self)continue;
      const id=frameId(packet.sender,packet.seq);
      if(packet.frameType===FRAME_TYPE.ack){
        const target=decodeAck(packet.payload);
        if(target){this.wire(`<- ${id} ACK ${frameId(target.sender,target.seq)}${recovery(packet)}`);this.options.ack?.(packet.sender,target);}
        else this.wire(`<- ${id} ACK ${hexBytes(packet.payload)} · malformed`);
        continue;
      }
      if(packet.frameType!==FRAME_TYPE.control){
        // A test packet on the control tones and baud also decodes here; the test listener reports it.
        if(!(packet.frameType===FRAME_TYPE.test&&this.test))
          this.wire(`<- ${id} ${FRAME_TYPE_NAMES[packet.frameType]??`type ${packet.frameType}`} ${hexBytes(packet.payload)}`);
        continue;
      }
      const m=decodeControl(packet.payload,packet.sender);
      if(!m){this.wire(`<- ${id} "${String.fromCharCode(...packet.payload)}" · unparseable control message`);continue;}
      this.wire(`<- ${describeWire(m,packet.seq,packet.payload)}${recovery(packet)}`);
      if(this.options.analyze&&m.kind==='test_suite')this.listenForTest(m);
      this.options.control?.(m,{seq:packet.seq,ackRequested:packet.ackRequested});
    }
    // While a test listener shares control's tones, its failures are reported there instead.
    const progress=this.control.drainProgress();
    if(!this.test)this.controlGarble.observe(progress);
    this.control.drainFrames();
    this.position+=chunk.length;
    if(this.test)this.pushTest(chunk);
  }
  private listenForTest(m:ControlMessage&{kind:'test_suite'}){
    const deadline=this.position+Math.round(testListenSeconds(m.settings)*this.sampleRate);
    const current=this.test?.proposal;
    // A repeated test_suite for the trial already being listened for just extends the window.
    if(current&&current.sender===m.sender&&current.trial===m.trial&&JSON.stringify(current.settings)===JSON.stringify(m.settings)){this.test!.deadline=deadline;return;}
    this.test={proposal:{sender:m.sender,trial:m.trial,settings:m.settings},deadline,heard:false,garbled:false,
      decoder:new FskStreamDecoder({...trialFsk(m.settings),sampleRate:this.sampleRate},this.position)};
  }
  private pushTest(chunk:Float32Array){
    const t=this.test!;
    t.decoder.push(chunk);
    const progress=t.decoder.drainProgress();
    if(!t.heard&&progress.some(p=>p.type==='sync')){t.heard=true;this.options.testHeard?.(t.proposal);}
    for(const received of t.decoder.drainFrames()){
      if(received.sender===this.options.self)continue;
      // Someone else's valid frame on these settings isn't our test packet.
      if(received.crcOk&&received.frameType!==FRAME_TYPE.test)continue;
      const m=scoreTestFrame(t.proposal,received,this.sampleRate);
      if(!m)continue;
      this.wire(`<- ${describeTestReceived(m)}`);
      this.test=undefined;
      this.options.measurement?.(m);
      return;
    }
    // A sync whose header then failed: keep listening, but note it.
    if(progress.some(p=>p.type==='crc-error')&&!t.garbled){t.garbled=true;this.wire(`X Trial ${t.proposal.trial+1} test packet heard but its header was unreadable`);}
    // Keep listening while a frame is mid-decode, even past the window.
    if(this.position>=t.deadline&&t.decoder.lockedSymbolAnchor()===undefined){
      this.wire(`X Trial ${t.proposal.trial+1} test packet not received (listened ${testListenSeconds(t.proposal.settings).toFixed(1)} s)`);
      this.test=undefined;
      this.options.lost?.(t.proposal);
    }
  }
}
