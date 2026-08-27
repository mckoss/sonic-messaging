class SonicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = true;
    this.sequence = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'set-capture') this.active = Boolean(data.active);
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (this.active && channel?.length) {
      const samples = channel.slice();
      this.port.postMessage({ type: 'samples', samples, sampleRate, sequence: this.sequence++ }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('sonic-capture', SonicCaptureProcessor);
