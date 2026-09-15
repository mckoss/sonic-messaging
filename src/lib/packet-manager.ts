import type { ControlMessage, Proposal } from './experiment';

export type PacketBody =
  | { kind: 'control'; message: ControlMessage }
  | { kind: 'trial'; proposal: Proposal }
  /** Confirms the frame `sender#seq`. */
  | { kind: 'ack'; sender: number; seq: number };
export interface OutgoingPacket { body: PacketBody; seq: number; ackRequested: boolean; attempt: number }
export interface PacketEvents {
  confirmed?: (seq: number, body: PacketBody) => void;
  failed?: (seq: number, body: PacketBody) => void;
  retry?: (packet: OutgoingPacket, retries: number) => void;
}

/** An ACK is a short frame; this allows for its air time, decode latency, and the peer finishing a transmission first. */
export const ACK_TIMEOUT_MS = 4000;
export const DEFAULT_RETRIES = 3;
const REMEMBERED_FRAMES = 256;

/**
 * Frame-level reliability shared by every protocol on top. Each outgoing frame gets the next 16-bit sequence number
 * (starting at a random value, so a restarted sender isn't mistaken for duplicates of its previous run). Frames sent
 * with an ACK requested are retransmitted with the same number when no ACK arrives in time, up to `retries` times, and
 * reported confirmed or failed. Incoming frames that request an ACK are always acknowledged, duplicates included (the
 * earlier ACK may be what was lost), but delivered only once.
 */
export class PacketManager {
  private nextSeq: number;
  private pending = new Map<number, { packet: OutgoingPacket; deadline: number }>();
  private seen = new Set<string>();

  constructor(readonly sender: number, private transmit: (packet: OutgoingPacket) => void, private events: PacketEvents = {},
    readonly retries = DEFAULT_RETRIES, readonly timeoutMs = ACK_TIMEOUT_MS, firstSeq = Math.floor(Math.random() * 0x10000)) {
    this.nextSeq = firstSeq & 0xffff;
  }

  send(body: PacketBody, ackRequested = false): number {
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    const packet = { body, seq, ackRequested, attempt: 0 };
    if (ackRequested) this.pending.set(seq, { packet, deadline: Infinity });
    this.transmit(packet);
    return seq;
  }

  /** Playback of `seq` finished; its ACK timer starts now. */
  sent(seq: number, now: number): void {
    const entry = this.pending.get(seq);
    if (entry) entry.deadline = now + this.timeoutMs;
  }

  /** An ACK frame arrived confirming `target#seq`. */
  acked(target: number, seq: number): void {
    if (target !== this.sender) return;
    const entry = this.pending.get(seq);
    if (!entry) return;
    this.pending.delete(seq);
    this.events.confirmed?.(seq, entry.packet.body);
  }

  /** A frame arrived. ACKs it when asked; returns true only the first time `sender#seq` is seen. */
  receive(sender: number, seq: number, ackRequested: boolean): boolean {
    if (ackRequested) this.send({ kind: 'ack', sender, seq });
    const key = `${sender}#${seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > REMEMBERED_FRAMES) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  tick(now: number): void {
    for (const [seq, entry] of [...this.pending]) {
      if (now < entry.deadline) continue;
      if (entry.packet.attempt >= this.retries) {
        this.pending.delete(seq);
        this.events.failed?.(seq, entry.packet.body);
        continue;
      }
      entry.packet = { ...entry.packet, attempt: entry.packet.attempt + 1 };
      entry.deadline = Infinity;
      this.events.retry?.(entry.packet, this.retries);
      this.transmit(entry.packet);
    }
  }

  /** Stops waiting on everything, without reporting failures. */
  clear(): void { this.pending.clear(); }
  get waiting(): number { return this.pending.size; }
}
