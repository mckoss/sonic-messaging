import { describe, expect, it } from 'vitest';
import { PacketManager, type OutgoingPacket, type PacketBody } from './packet-manager';

const body: PacketBody = { kind: 'control', message: { kind: 'lost', sender: 1, trial: 0 } };

describe('packet manager', () => {
  it('numbers every frame, wrapping at 16 bits', () => {
    const sent: OutgoingPacket[] = [], manager = new PacketManager(1, p => sent.push(p), {}, 3, 4000, 0xfffe);
    manager.send(body); manager.send(body, true); manager.send(body);
    expect(sent.map(p => [p.seq, p.ackRequested])).toEqual([[0xfffe, false], [0xffff, true], [0, false]]);
  });
  it('confirms on ACK and ignores ACKs for other senders or unknown frames', () => {
    const confirmed: number[] = [], manager = new PacketManager(1, () => {}, { confirmed: seq => confirmed.push(seq) }, 3, 4000, 10);
    const seq = manager.send(body, true);
    manager.acked(2, seq); manager.acked(1, 99);
    expect(confirmed).toEqual([]);
    manager.acked(1, seq); manager.acked(1, seq);
    expect(confirmed).toEqual([seq]); expect(manager.waiting).toBe(0);
  });
  it('retries N times after the timeout, starting once playback finishes, then reports failure', () => {
    const sent: OutgoingPacket[] = [], failed: number[] = [];
    const manager = new PacketManager(1, p => sent.push(p), { failed: seq => failed.push(seq) }, 3, 4000, 0);
    const seq = manager.send(body, true);
    manager.tick(1e6); expect(sent).toHaveLength(1); // no timer until sent()
    let now = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      manager.sent(seq, now); manager.tick(now + 3999); expect(sent).toHaveLength(attempt);
      now += 4000; manager.tick(now);
      expect(sent[attempt]).toMatchObject({ seq, attempt, body });
    }
    manager.sent(seq, now); manager.tick(now + 4000);
    expect(sent).toHaveLength(4); expect(failed).toEqual([seq]); expect(manager.waiting).toBe(0);
  });
  it('ACKs every copy of a frame that asks, but delivers it only once', () => {
    const sent: OutgoingPacket[] = [], manager = new PacketManager(9, p => sent.push(p), {}, 3, 4000, 50);
    expect(manager.receive(7, 300, true)).toBe(true);
    expect(manager.receive(7, 300, true)).toBe(false);
    expect(manager.receive(8, 300, false)).toBe(true);
    expect(sent.map(p => p.body)).toEqual([{ kind: 'ack', sender: 7, seq: 300 }, { kind: 'ack', sender: 7, seq: 300 }]);
    expect(sent.every(p => !p.ackRequested)).toBe(true);
  });
});
