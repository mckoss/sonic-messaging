import { MAX_SESSION_SECONDS, ParameterSearch, testListenSeconds, testSymbolCount, type ControlMessage, type CooperativeEvent, type Proposal,
  type SearchSettings, type TrialMeasurement } from './experiment';
import { ACK_TIMEOUT_MS, DEFAULT_RETRIES, type PacketBody } from './packet-manager';

/** Sends a frame through the packet manager; returns its sequence number. */
export type SendPacket = (body: PacketBody, ackRequested: boolean) => number;

/**
 * The cooperative test protocol, on top of the packet manager's ACKs and retries:
 *   controller: test_suite(T, …) [ACK]  →  test packet  →  partner: result(T, …) or lost(T) [ACK]  →  next trial
 * The partner is passive: it has no settings, follows the controller it last heard a test_suite from, treats that
 * controller counting trials back down as a restarted run, and listens until stopped.
 */
export class CooperativeSession {
  private phase='idle';
  private proposal?:Proposal;
  private suiteSeq?:number;
  private doneSeq?:number;
  /** Controller: when to give up waiting for this trial's result or lost. */
  private resultDeadline=Infinity;
  private started?:number;
  /** The controller a partner is following. */
  private controller?:number;
  private search?:ParameterSearch;
  private nextId=0;
  private finished=false;
  constructor(readonly role:'controller'|'partner', config:SearchSettings|undefined, readonly sender:number,
    private send:SendPacket, private event:(event:CooperativeEvent)=>void) {
    if(role==='controller'){if(!config)throw new Error('Controller requires search settings');this.search=new ParameterSearch(config);}
  }
  private status(phase:string,detail:string,finished=false,log=false){this.phase=phase;this.finished=finished;this.event({kind:'status',phase,detail,finished,log});}
  start(now:number){this.started=now;if(this.role==='controller')this.next();else this.status('listening','Listening for a controller.');}
  private control(message:ControlMessage){return this.send({kind:'control',message},true);}
  private next(){
    this.resultDeadline=Infinity;this.suiteSeq=undefined;
    const settings=this.search!.next();
    if(!settings){this.status('finishing','Finishing the cooperative session.');this.doneSeq=this.control({kind:'done',sender:this.sender,trial:this.nextId});return;}
    this.proposal={sender:this.sender,trial:this.nextId++,settings};
    this.status('waiting-ack',`Proposing trial ${this.proposal.trial+1}.`);
    this.suiteSeq=this.control({kind:'test_suite',...this.proposal});
  }
  /** The packet manager heard the ACK for frame `seq`. */
  confirmed(seq:number){
    if(this.finished)return;
    if(seq===this.doneSeq){this.status('complete','Search complete; best means best measured across these tests.',true);return;}
    if(this.role==='controller'&&seq===this.suiteSeq&&this.phase==='waiting-ack'){
      this.status('testing',`Trial ${this.proposal!.trial+1} confirmed; sending its test packet.`);
      this.send({kind:'trial',proposal:this.proposal!},false);
    }
  }
  /** The packet manager gave up on frame `seq` after its retries. */
  failed(seq:number,body:PacketBody){
    if(this.finished)return;
    if(seq===this.doneSeq){this.status('complete','Search complete; the partner did not confirm done.',true);return;}
    if(this.role==='controller'&&seq===this.suiteSeq){this.stop('No ACK for test_suite after retries; the control link timed out.');return;}
    if(this.role==='partner'&&body.kind==='control')
      this.status('listening',`Trial ${body.message.trial+1} ${body.message.kind} was never confirmed; still listening.`,false,true);
  }
  /** Controller: the test packet finished playing; the partner's result or lost should follow. */
  trialSent(now:number){
    if(this.finished||this.role!=='controller'||this.phase!=='testing')return;
    // The partner replies when its listener closes, then may need every retry to get the reply through.
    this.resultDeadline=now+testListenSeconds(this.proposal!.settings)*1000+(DEFAULT_RETRIES+1)*(ACK_TIMEOUT_MS+3000);
    this.status('waiting-result',`Trial ${this.proposal!.trial+1} sent; waiting for the partner's result.`);
  }
  /** A control message delivered once by the packet manager (duplicates are already ACKed and dropped). */
  receive(m:ControlMessage){
    if(this.finished)return;
    if(this.role==='partner'){
      if(m.kind==='test_suite'){
        // A new controller, or the same one counting trials back down (restarted): follow it.
        this.controller=m.sender;this.proposal={sender:m.sender,trial:m.trial,settings:m.settings};
        this.status('waiting-test',`Listening for trial ${m.trial+1} test packet.`);return;
      }
      if(m.sender===this.controller&&m.kind==='done')this.status('listening','Controller finished; still listening for the next run.',false,true);
      return;
    }
    if(m.sender===this.sender||m.trial!==this.proposal?.trial||(this.phase!=='testing'&&this.phase!=='waiting-result'))return;
    if(m.kind==='result'){
      const p=this.proposal!;
      if(m.raw.bits!==p.settings.payloadBytes*8||m.raw.symbols!==testSymbolCount(p.settings))return;
      const observation={...p,raw:m.raw};
      if(this.search!.add(observation))this.event({kind:'feedback',observation,best:this.search!.best()});
      this.next();
    }else if(m.kind==='lost'){
      // Not lost feedback: the partner never received the packet, so propose the same point again as a new trial.
      this.event({kind:'lost',proposal:this.proposal!});
      this.status('lost',`Partner did not receive trial ${m.trial+1}; proposing it again.`,false,true);
      this.next();
    }
  }
  /** Partner: the test listener heard the expected packet's sync. */
  testHeard(p:Proposal){
    if(this.finished||this.role!=='partner'||p.sender!==this.controller||p.trial!==this.proposal?.trial)return;
    this.status('measuring',`Receiving trial ${p.trial+1} test packet.`);
  }
  measured(m:TrialMeasurement){
    if(this.finished||this.role!=='partner'||m.sender!==this.controller||m.trial!==this.proposal?.trial)return;
    this.status('reporting',`Returning trial ${m.trial+1} result.`);
    this.control({kind:'result',sender:this.sender,trial:m.trial,raw:m.raw});
  }
  /** Partner: the test listener closed without receiving the packet. */
  lost(p:Proposal){
    if(this.finished||this.role!=='partner'||p.sender!==this.controller||p.trial!==this.proposal?.trial)return;
    this.status('reporting',`Trial ${p.trial+1} test packet not received; telling the controller.`,false,true);
    this.control({kind:'lost',sender:this.sender,trial:p.trial});
  }
  tick(now:number){
    if(this.finished)return;
    if(this.started!==undefined&&now-this.started>MAX_SESSION_SECONDS*1000){this.stop('Session time limit reached; completed measurements are retained.');return;}
    if(this.role==='controller'&&now>=this.resultDeadline){
      this.event({kind:'lost',proposal:this.proposal!});
      this.status('lost',`No result for trial ${this.proposal!.trial+1}; proposing it again.`,false,true);
      this.next();
    }
  }
  stop(detail='Stopped; partial recordings and completed measurements are retained.'){
    this.resultDeadline=Infinity;this.status('stopped',detail,true);
  }
}
