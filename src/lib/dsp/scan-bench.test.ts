import { expect, it } from 'vitest';
import { encodeFsk } from './fsk';
import { FskStreamDecoder } from './fsk-stream';

it('rescans a rejected low-baud 8-FSK frame in well under a second', () => {
  const config = { sampleRate: 48_000, symbolRate: 25, frequencies: [220, 250, 280, 310, 340, 370, 400, 430] };
  const first = encodeFsk(new TextEncoder().encode('SONIC TEST 001'), config).samples;
  const second = encodeFsk(new TextEncoder().encode('SONIC TEST 002'), config).samples;
  const samples = new Float32Array(first.length + second.length);
  samples.set(first); samples.set(second, first.length);
  const samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
  samples.fill(0, 40 * samplesPerSymbol, 43 * samplesPerSymbol);
  const receiver = new FskStreamDecoder(config);
  const started = performance.now();
  const packets: string[] = [];
  for (let offset = 0; offset < samples.length; offset += 2048) {
    for (const packet of receiver.push(samples.subarray(offset, offset + 2048))) {
      packets.push(new TextDecoder().decode(packet.payload));
    }
  }
  const elapsed = performance.now() - started;
  expect(packets).toEqual(['SONIC TEST 002']);
  expect(elapsed).toBeLessThan(1000);
  console.log(`rescan bench: ${elapsed.toFixed(0)} ms for ${(samples.length / 48_000).toFixed(1)} s of audio`);
});
