class SonicPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.gain = 1;
    this.wasPlaying = false;
    this.playedSamples = 0;
    this.lastReported = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'enqueue' && data.samples instanceof Float32Array) {
        if (!this.queue.length && !this.wasPlaying) { this.playedSamples = 0; this.lastReported = 0; }
        this.queue.push(data.samples);
      }
      if (data?.type === 'clear') {
        this.queue = []; this.offset = 0; this.wasPlaying = false;
        this.port.postMessage({ type: 'playback-progress', samples: this.playedSamples });
        if (data.requestId) this.port.postMessage({ type: 'playback-cleared', requestId: data.requestId });
      }
      if (data?.type === 'set-gain') this.gain = Math.max(0, Number(data.gain) || 0);
    };
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels?.length) return true;
    const mono = channels[0];
    mono.fill(0);
    let destination = 0;
    while (destination < mono.length && this.queue.length) {
      const block = this.queue[0];
      const count = Math.min(mono.length - destination, block.length - this.offset);
      for (let i = 0; i < count; i++) mono[destination + i] = block[this.offset + i] * this.gain;
      destination += count;
      this.offset += count;
      if (this.offset === block.length) { this.queue.shift(); this.offset = 0; }
    }
    for (let channel = 1; channel < channels.length; channel++) channels[channel].set(mono);
    if (destination > 0) this.wasPlaying = true;
    this.playedSamples += destination;
    if (this.playedSamples - this.lastReported >= sampleRate / 10 || (this.wasPlaying && !this.queue.length)) {
      this.lastReported = this.playedSamples;
      this.port.postMessage({ type: 'playback-progress', samples: this.playedSamples });
    }
    if (this.wasPlaying && this.queue.length === 0 && destination < mono.length) {
      this.wasPlaying = false;
      this.port.postMessage({ type: 'playback-drained' });
    }
    return true;
  }
}

registerProcessor('sonic-playback', SonicPlaybackProcessor);
