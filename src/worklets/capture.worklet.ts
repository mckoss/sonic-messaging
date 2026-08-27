declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

class SonicCaptureProcessor extends AudioWorkletProcessor {
  private active = true;
  private sequence = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'set-capture') this.active = Boolean(data.active);
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (this.active && channel?.length) {
      const samples = channel.slice();
      this.port.postMessage({ type: 'samples', samples, sampleRate, sequence: this.sequence++ }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor('sonic-capture', SonicCaptureProcessor);
export {};
