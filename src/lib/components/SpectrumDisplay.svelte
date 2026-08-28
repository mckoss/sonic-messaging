<script lang="ts">
  import { onMount } from 'svelte';
  import { DETECTOR_HOP_SAMPLES, dbToIntensity, frequencyBinRange, intensityToRgb, ringSpans, WATERFALL_AHEAD_TRIM, WATERFALL_HISTORY_SECONDS, WATERFALL_MAX_RING_PIXELS, WATERFALL_SAMPLES_PER_CSS_PIXEL, WATERFALL_STALL_FREE_RUN_SECONDS, waterfallPixelAdvance } from '../audio/waterfall';
  import { replayPlaybackPosition, waterfallScrubSamples } from '../audio/scrub-store';

  export let spectrum: number[] | Float32Array = [];
  export let sampleRate = 48_000;
  export let minFrequency = 0;
  export let maxFrequency = 24_000;
  export let label = 'Live receiver spectrum';
  export let sequence = -1;
  export let samplePosition = -1;
  export let samplesPerCssPixel = WATERFALL_SAMPLES_PER_CSS_PIXEL;
  /** While capturing, scroll on real time through worker stalls; late data backfills. */
  export let live = false;

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800;
  let height = 220;
  let lastSequence = -1, latestPosition = -1, lastPaintedPosition = -1, renderedPosition = -1;
  // History lives in a ring canvas; the visible canvas is a scrubable viewport.
  let ring: HTMLCanvasElement | undefined;
  let ringWidth = 0, ringRatio = 1, ringSpp = WATERFALL_SAMPLES_PER_CSS_PIXEL, ringRate = 48_000, ringHeight = 0;
  let originPosition = 0, clearedX = 0;

  $: scrubSamples = $waterfallScrubSamples;

  function pixelRatio(): number { return Math.max(1, window.devicePixelRatio || 1); }

  function ensureRing(): void {
    const ratio = pixelRatio();
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (ring && ringRatio === ratio && ringSpp === samplesPerCssPixel && ringRate === sampleRate && ringHeight === pixelHeight) return;
    ringRatio = ratio; ringSpp = samplesPerCssPixel; ringRate = sampleRate; ringHeight = pixelHeight;
    ringWidth = Math.min(WATERFALL_MAX_RING_PIXELS,
      Math.ceil(waterfallPixelAdvance(WATERFALL_HISTORY_SECONDS * sampleRate, ratio, samplesPerCssPixel)));
    ring = document.createElement('canvas');
    ring.width = ringWidth; ring.height = pixelHeight;
    const ctx = ring.getContext('2d', { alpha: false })!;
    ctx.fillStyle = 'rgb(5, 10, 24)'; ctx.fillRect(0, 0, ringWidth, pixelHeight);
    originPosition = Math.max(0, latestPosition); clearedX = 0;
    lastPaintedPosition = latestPosition;
  }

  function xOf(position: number): number {
    return waterfallPixelAdvance(position - originPosition, ringRatio, ringSpp);
  }

  function ensureCleared(x: number): void {
    if (!ring || x <= clearedX) return;
    const ctx = ring.getContext('2d', { alpha: false })!;
    ctx.fillStyle = 'rgb(5, 10, 24)';
    for (const span of ringSpans(clearedX, x - clearedX, ringWidth)) ctx.fillRect(span.x, 0, span.w, ringHeight);
    clearedX = x;
  }

  function ingest() {
    if (!canvas || spectrum.length === 0 || sequence === lastSequence || samplePosition < 0) return;
    lastSequence = sequence;
    if (samplePosition < latestPosition) { ring = undefined; latestPosition = -1; lastPaintedPosition = -1; renderedPosition = -1; }
    latestPosition = samplePosition;
    if (renderedPosition < 0) renderedPosition = samplePosition;
    ensureRing();
    if (lastPaintedPosition < 0) { lastPaintedPosition = samplePosition; return; }
    const columnWidth = Math.floor(waterfallPixelAdvance(samplePosition - lastPaintedPosition, ringRatio, ringSpp));
    if (columnWidth < 1) return;
    const columnEnd = Math.floor(xOf(samplePosition));
    ensureCleared(columnEnd);
    const ctx = ring!.getContext('2d', { alpha: false })!;
    const { start, end } = frequencyBinRange(spectrum.length, sampleRate, minFrequency, maxFrequency);
    const span = end - start;
    for (const segment of ringSpans(columnEnd - columnWidth, columnWidth, ringWidth)) {
      const column = ctx.createImageData(segment.w, ringHeight);
      for (let y = 0; y < ringHeight; y++) {
        const position = (ringHeight - 1 - y) / ringHeight;
        const binStart = start + Math.floor(position * span);
        const binEnd = Math.max(binStart + 1, start + Math.ceil((position + 1 / ringHeight) * span));
        let peakDb = -110;
        for (let bin = binStart; bin < Math.min(end, binEnd); bin++) {
          const value = spectrum[bin];
          if (Number.isFinite(value)) peakDb = Math.max(peakDb, value);
        }
        const [red, green, blue] = intensityToRgb(dbToIntensity(peakDb));
        for (let x = 0; x < segment.w; x++) {
          const offset = (y * segment.w + x) * 4;
          column.data[offset] = red;
          column.data[offset + 1] = green;
          column.data[offset + 2] = blue;
          column.data[offset + 3] = 255;
        }
      }
      ctx.putImageData(column, segment.x, 0);
    }
    lastPaintedPosition += columnWidth * ringSpp / ringRatio;
  }

  function maxScrubSamples(): number {
    if (!ring || renderedPosition < 0) return 0;
    const capacityPx = Math.max(0, ringWidth - Math.round(width * ringRatio));
    return Math.max(0, Math.min(renderedPosition - originPosition, capacityPx * ringSpp / ringRatio));
  }

  function blit() {
    if (!ring || !canvas || renderedPosition < 0) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const pixelWidth = Math.max(1, Math.round(width * ringRatio));
    if (canvas.width !== pixelWidth || canvas.height !== ringHeight) {
      canvas.width = pixelWidth; canvas.height = ringHeight;
    }
    ctx.fillStyle = 'rgb(5, 10, 24)'; ctx.fillRect(0, 0, pixelWidth, ringHeight);
    const headX = Math.floor(xOf(renderedPosition));
    const backPx = Math.floor(waterfallPixelAdvance(
      Math.min(scrubSamples, maxScrubSamples()), ringRatio, ringSpp));
    const end = headX - backPx;
    let start = end - pixelWidth, dx = 0;
    const oldest = Math.max(0, headX - ringWidth + 1);
    if (start < oldest) { dx = oldest - start; start = oldest; }
    if (end <= start) return;
    for (const segment of ringSpans(start, end - start, ringWidth)) {
      ctx.drawImage(ring, segment.x, 0, segment.w, ringHeight, dx, 0, segment.w, ringHeight);
      dx += segment.w;
    }
  }

  // CSS-pixel x of the replay playback cursor within the viewport, or -1 when hidden.
  let sweepLeft = -1;
  function updateSweep() {
    const position = $replayPlaybackPosition;
    if (position < 0 || !ring || renderedPosition < 0) { sweepLeft = -1; return; }
    const backPx = Math.floor(waterfallPixelAdvance(
      Math.min(scrubSamples, maxScrubSamples()), ringRatio, ringSpp));
    const pixelWidth = Math.max(1, Math.round(width * ringRatio));
    const x = xOf(position) - (Math.floor(xOf(renderedPosition)) - backPx - pixelWidth);
    sweepLeft = x >= 0 && x <= pixelWidth ? x / ringRatio : -1;
  }

  let dragPointer = -1, dragX = 0;
  function scrubStart(event: PointerEvent) {
    dragPointer = event.pointerId; dragX = event.clientX;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }
  function scrubMove(event: PointerEvent) {
    if (event.pointerId !== dragPointer) return;
    const dx = event.clientX - dragX; dragX = event.clientX;
    waterfallScrubSamples.update(value =>
      Math.max(0, Math.min(value + dx * samplesPerCssPixel, maxScrubSamples())));
  }
  function scrubEnd(event: PointerEvent) {
    if (event.pointerId === dragPointer) dragPointer = -1;
  }

  $: spectrum, sequence, samplePosition, samplesPerCssPixel, sampleRate, minFrequency, maxFrequency, ingest();
  $: scrubSamples, width, height, blit();

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => {
      width = Math.max(280, Math.floor(entry.contentRect.width));
      height = width < 560 ? 176 : 220;
    });
    resize.observe(host);
    let frame = 0, lastTime = -1;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (renderedPosition < 0 || latestPosition < 0) { lastTime = now; return; }
      const dt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      // Free-run at the audio rate with bounded catch-up when the worker is behind.
      // While capturing (live), time keeps scrolling through worker stalls — blank
      // columns appear at the live edge and late worker data backfills them — up to
      // a bound so a dead worker or stopped capture halts the display eventually.
      // When not live, ease to a stop within two hops of the data so the last
      // painted audio stays pinned to the display's right edge.
      // More than a second behind (e.g. returning to a background-throttled tab):
      // jump to the data head; the scrub offset is delay-from-live, so it is kept.
      const lag = latestPosition - renderedPosition;
      const aheadLimit = live ? WATERFALL_STALL_FREE_RUN_SECONDS * sampleRate : 2 * DETECTOR_HOP_SAMPLES;
      if (lag > sampleRate) {
        renderedPosition = latestPosition;
      } else {
        const factor = lag >= 0 ? Math.min(8, 1 + 2 * lag / sampleRate)
          : live ? WATERFALL_AHEAD_TRIM
          : Math.max(0, 1 + lag / (2 * DETECTOR_HOP_SAMPLES));
        renderedPosition = Math.min(renderedPosition + dt * sampleRate * factor,
          latestPosition + aheadLimit);
      }
      ensureRing();
      ensureCleared(Math.floor(xOf(renderedPosition)));
      blit();
      updateSweep();
    };
    frame = requestAnimationFrame(tick);
    return () => { resize.disconnect(); cancelAnimationFrame(frame); };
  });
</script>

<div class="figure" bind:this={host} data-testid="spectrum-waterfall" data-samples-per-css-pixel={samplesPerCssPixel} aria-label={`${label}; waterfall display, newest samples at right`} role="img">
  <div class="plot"><div class="axis"><span>{Math.round(maxFrequency / 100) / 10} kHz</span><span>{Math.round(minFrequency / 100) / 10} kHz</span></div><div class="spectrum scrub" role="presentation" on:pointerdown={scrubStart} on:pointermove={scrubMove} on:pointerup={scrubEnd} on:pointercancel={scrubEnd}><canvas bind:this={canvas} aria-hidden="true"></canvas>{#if sweepLeft >= 0}<div class="sweep" data-testid="replay-sweep" style={`left:${sweepLeft.toFixed(2)}px`} aria-hidden="true"></div>{/if}{#if scrubSamples > 0}<button class="live" on:pointerdown|stopPropagation on:click={() => waterfallScrubSamples.set(0)}>◀ {(scrubSamples / sampleRate).toFixed(1)}s · LIVE ▶</button>{/if}</div></div>
</div>

<style>
  .figure { width: 100%; }
  .plot { display:grid; grid-template-columns:62px 1fr; gap:6px; }
  .spectrum { position:relative; width: 100%; min-width:0; min-height:176px; overflow:hidden; border-radius:14px; background:#050a18; }
  canvas { display: block; width: 100%; height: 220px; }
  .scrub { cursor:grab; touch-action:none; }
  .scrub:active { cursor:grabbing; }
  .live { position:absolute; top:7px; right:9px; border:1px solid #2c8e6f; border-radius:99px; padding:4px 10px; background:#0b2c22e6; color:#4ee8b4; font:600 10px ui-monospace,monospace; cursor:pointer; }
  .sweep { position:absolute; top:0; bottom:0; width:2px; margin-left:-1px; background:#ff4b63; box-shadow:0 0 7px #ff4b63b0; pointer-events:none; }
  .axis { color: #8294aa; font: 10px/1.2 ui-monospace, monospace; pointer-events: none; }
  .axis { display:flex; flex-direction:column; justify-content:space-between; padding:1px 0; text-align:right; }
  @media (max-width: 559px) { canvas { height: 176px; } }
</style>
