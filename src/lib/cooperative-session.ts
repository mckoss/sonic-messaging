import { MAX_RETRIES, MAX_SESSION_SECONDS, REPLY_TIMEOUT_MS, ParameterSearch, type ControlMessage, type CooperativeEvent, type Proposal,
  type SearchSettings, type TrialMeasurement } from './experiment';
export type Outgoing = { kind:'control'; message:ControlMessage } | { kind:'trial'; proposal:Proposal };
/** Stop-and-wait coordination. Retries resend coordination/results, never the measured waveform.
 * The partner is passive: it has no settings, follows the newest controller run and listens until stopped. */
export class CooperativeSession {
  private phase='idle';
  private proposal?:Proposal;
  private result?:ControlMessage & {kind:'result'};
  private retry?:Outgoing;
  private attempts=0;
  private deadline=Infinity;
  private started?:number;
  private session?:number;
  private search?:ParameterSearch;
  private nextId=0;
  private finished=false;
  constructor(readonly role:'controller'|'partner', config:SearchSettings|undefined, session:number,
    private output:(action:Outgoing)=>void, private event:(event:CooperativeEvent)=>void) {
    if(role==='controller'){if(!config)throw new Error('Controller requires search settings');this.session=session;this.search=new ParameterSearch(config);}
  }
  private status(phase:string,detail:string,finished=false,log=false){this.phase=phase;this.finished=finished;this.event({kind:'status',phase,detail,finished,log});}
  start(now:number){this.started=now;if(this.role==='controller')this.next();else this.status('listening','Listening for a controller.');}
  private send(action:Outgoing,retry=true){this.deadline=Infinity;if(retry){this.retry=action;this.attempts=0;}this.output(action);}
  private next(){
    const settings=this.search!.next();
    if(!settings){this.status('finishing','Finishing the cooperative session.');this.send({kind:'control',message:{kind:'done',session:this.session!,trial:this.nextId}},false);return;}
    this.proposal={session:this.session!,trial:this.nextId++,settings};
    this.status('waiting-ready',`Negotiating trial ${this.proposal.trial+1}.`);
    this.send({kind:'control',message:{kind:'test_suite',...this.proposal}});
  }
  /** Called only after speaker playback drains. */
  sent(now:number){
    if(this.finished)return;
    if(this.phase==='acknowledging'){this.next();return;}
    if(this.phase==='finishing'){this.status('complete','Search complete; best means best measured within this budget.',true);return;}
    this.deadline=now+REPLY_TIMEOUT_MS;
  }
  receive(m:ControlMessage){
    if(this.finished)return;
    if(this.role==='partner'){
      if(m.kind==='test_suite'){
        if(this.proposal&&m.session===this.session&&m.trial<this.proposal.trial)return;
        if(this.proposal&&m.session===this.session&&m.trial===this.proposal.trial){
          if(JSON.stringify(m.settings)!==JSON.stringify(this.proposal.settings))return;
          if(this.result)this.send({kind:'control',message:this.result});
          else this.send({kind:'control',message:{kind:'ready',session:m.session,trial:m.trial}});
          return;
        }
        // A different session means the controller restarted; abandon the old run rather than ignore the new one.
        this.session=m.session;this.proposal={session:m.session,trial:m.trial,settings:m.settings};this.result=undefined;
        this.status('waiting-test',`Ready for trial ${m.trial+1}; timing will come from control markers.`);
        this.send({kind:'control',message:{kind:'ready',session:m.session,trial:m.trial}});return;
      }
      if(m.session!==this.session)return;
      if(m.kind==='done'){this.retry=undefined;this.deadline=Infinity;this.status('listening','Controller finished; still listening for the next run.',false,true);return;}
      if(m.trial!==this.proposal?.trial)return;
      if(m.kind==='test') {this.deadline=Infinity;this.status('measuring',`Capturing trial ${m.trial+1}.`);return;}
      if(m.kind==='query'&&this.result){this.send({kind:'control',message:this.result});return;}
      if(m.kind==='query'){
        // Without both timing markers there is nothing to report; say so instead of leaving the controller querying.
        this.retry=undefined;this.deadline=Infinity;
        this.status('listening',`Missed trial ${m.trial+1} (timing markers not heard); told the controller.`,false,true);
        this.send({kind:'control',message:{kind:'lost',session:m.session,trial:m.trial}},false);return;
      }
      if(m.kind==='ack'&&this.result){this.retry=undefined;this.deadline=Infinity;this.status('listening','Result acknowledged; waiting for the next candidate.');return;}
    }else{
      if(m.session!==this.session)return;
      // The partner is still repeating an earlier result, so our ack was lost; repeat it once.
      if(m.kind==='result'&&this.proposal&&m.trial<this.proposal.trial){this.output({kind:'control',message:{kind:'ack',session:m.session,trial:m.trial}});return;}
      if(m.trial!==this.proposal?.trial)return;
      if(m.kind==='ready'&&this.phase==='waiting-ready'){
        this.status('waiting-result',`Transmitting trial ${m.trial+1}; then waiting for receiver error counts.`);
        this.retry={kind:'control',message:{kind:'query',session:m.session,trial:m.trial}};this.attempts=0;
        this.send({kind:'trial',proposal:this.proposal!},false);return;
      }
      if(m.kind==='result'&&this.phase==='waiting-result'){
        const p=this.proposal!,bps=Math.log2(p.settings.tones),symbols=Math.floor((56+p.settings.payloadBytes*8)/bps)-Math.ceil(56/bps);
        if(m.raw.bits!==p.settings.payloadBytes*8||m.raw.symbols!==symbols)return;
        const observation={...p,raw:m.raw};
        if(this.search!.add(observation))this.event({kind:'feedback',observation,best:this.search!.best()});
        this.status('acknowledging',`Received trial ${m.trial+1}: ${m.raw.symbolErrors}/${m.raw.symbols} symbol errors.`);
        this.send({kind:'control',message:{kind:'ack',session:m.session,trial:m.trial}},false);
      }
      if(m.kind==='lost'&&this.phase==='waiting-result'){
        // Not lost feedback: the partner never measured it, so propose the same point again as a new trial.
        this.status('waiting-ready',`Partner missed trial ${m.trial+1}; proposing it again.`,false,true);
        this.next();
      }
    }
  }
  measured(m:TrialMeasurement){
    if(this.finished||this.role!=='partner'||m.session!==this.session||m.trial!==this.proposal?.trial)return;
    this.result={kind:'result',session:m.session,trial:m.trial,raw:m.raw};
    this.status('waiting-ack',`Returning trial ${m.trial+1} error counts.`);this.send({kind:'control',message:this.result});
  }
  tick(now:number){
    if(this.finished)return;
    if(this.started!==undefined&&now-this.started>MAX_SESSION_SECONDS*1000){this.stop('Session time limit reached; completed measurements are retained.');return;}
    if(now<this.deadline||!this.retry)return;
    if(++this.attempts>MAX_RETRIES){
      if(this.role==='partner'){this.retry=undefined;this.deadline=Infinity;this.status('listening','No response from controller; still listening.',false,true);return;}
      this.stop('Control link timed out. The test waveform was not automatically repeated.');return;
    }
    this.deadline=Infinity;this.output(this.retry);this.event({kind:'status',phase:this.phase,detail:`No reply; retrying control exchange (${this.attempts}/${MAX_RETRIES}).`,log:true});
  }
  stop(detail='Stopped; partial recordings and completed measurements are retained.'){
    this.retry=undefined;this.deadline=Infinity;this.status('stopped',detail,true);
  }
}
