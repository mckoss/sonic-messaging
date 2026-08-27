import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModemLabWorker, WORKER_REQUEST_TIMEOUT_MS } from './modem-lab';

class SilentWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

describe('ModemLabWorker error recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', SilentWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rejects instead of hanging when a worker never responds', async () => {
    const lab = new ModemLabWorker();
    const result = lab.encode({ mode: 'DSSS', payload: 'test', settings: {} });
    const rejection = expect(result).rejects.toThrow('DSP worker did not respond within 30 seconds');
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    await rejection;
    lab.dispose();
  });
});
