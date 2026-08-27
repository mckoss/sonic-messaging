/** A fixed-capacity mono PCM ring. Old samples are discarded on overflow. */
export class Float32RingBuffer {
  readonly capacity: number;
  private readonly data: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private used = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  get length(): number { return this.used; }
  get availableWrite(): number { return this.capacity - this.used; }

  clear(): void {
    this.readIndex = this.writeIndex = this.used = 0;
  }

  push(input: ArrayLike<number>): number {
    const dropped = Math.max(0, this.used + input.length - this.capacity);
    const droppedFromRing = Math.min(this.used, dropped);
    if (droppedFromRing) {
      this.readIndex = (this.readIndex + droppedFromRing) % this.capacity;
      this.used -= droppedFromRing;
    }
    const start = dropped - droppedFromRing;
    for (let i = start; i < input.length; i++) {
      this.data[this.writeIndex] = input[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.used++;
    }
    return dropped;
  }

  pull(output: Float32Array): number {
    const count = Math.min(output.length, this.used);
    for (let i = 0; i < count; i++) {
      output[i] = this.data[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacity;
    }
    if (count < output.length) output.fill(0, count);
    this.used -= count;
    return count;
  }
}
