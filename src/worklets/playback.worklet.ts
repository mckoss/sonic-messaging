declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

class SonicPlaybackProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = [];
  private offset = 0;
  private gain = 1;
  private wasPlaying = false;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'enqueue' && data.samples instanceof Float32Array) this.queue.push(data.samples);
      if (data?.type === 'clear') { this.queue = []; this.offset = 0; }
      if (data?.type === 'set-gain') this.gain = Math.max(0, Number(data.gain) || 0);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels?.length) return true;
    const mono = channels[0];
    mono.fill(0);
    let destination = 0;
    while (destination < mono.length && this.queue.length) {
      const block = this.queue[0];
      const count = Math.min(mono.length - destination, block.length - this.offset);
      for (let i = 0; i < count; i++) mono[destination + i] = block[this.offset + i] * this.gain;
      destination += count; this.offset += count;
      if (this.offset === block.length) { this.queue.shift(); this.offset = 0; }
    }
    for (let channel = 1; channel < channels.length; channel++) channels[channel].set(mono);
    if (destination > 0) this.wasPlaying = true;
    if (this.wasPlaying && this.queue.length === 0 && destination < mono.length) {
      this.wasPlaying = false;
      this.port.postMessage({ type: 'playback-drained' });
    }
    return true;
  }
}
registerProcessor('sonic-playback', SonicPlaybackProcessor);
export {};
