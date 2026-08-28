<script lang="ts">
  import { onMount } from 'svelte';
  import { DETECTOR_HOP_SAMPLES, intensityToRgb, ringSpans, WATERFALL_HISTORY_SECONDS, WATERFALL_MAX_RING_PIXELS, WATERFALL_SAMPLES_PER_CSS_PIXEL, waterfallPixelAdvance } from '../audio/waterfall';
  import { replayPlaybackPosition, waterfallScrubSamples, waterfallView } from '../audio/scrub-store';

  export let scores: Float32Array = new Float32Array();
  export let labels: string[] = [];
  export let sequence = -1;
  export let messages: string[] = [];
  export let currentMessage = '';
  export let markers: Array<{ id: number; label: string; symbols: number; position: number }> = [];
  export let confidence = 0;
  export let sampleRate = 48_000;
  export let symbolRate = 100;
  export let samplePosition = -1;
  export let samplesPerCssPixel = WATERFALL_SAMPLES_PER_CSS_PIXEL;

  // Lowest tone at the bottom, matching the spectrogram's frequency axis.
  $: displayLabels = [...labels].reverse();
  $: recentEntries = currentMessage ? [...messages, currentMessage] : messages;
  $: recentMessages = recentEntries.length ? `| ${recentEntries.join(' | ')} |` : '';
  $: scrubSamples = $waterfallScrubSamples;

  const SYMBOL_HEIGHT = 150, CONFIDENCE_HEIGHT = 22, TIMELINE_HEIGHT = 34;

  let canvas: HTMLCanvasElement;
  let confidenceCanvas: HTMLCanvasElement;
  let timelineCanvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800;
  // The lanes advance on their own animation clock (sample-time at the live edge),
  // rate-locked to the worker's sample positions; late worker data backfills history.
  let renderedPosition = -1, latestPosition = -1;
  let lastSequence = -1, lastPaintedPosition = -1, lastMarkerId = -1;
  let pendingScores = new Float32Array(0), pendingConfidence = 0;
  // History lives in ring canvases; the visible canvases are a scrubable viewport.
  let rings: { symbol: HTMLCanvasElement; confidence: HTMLCanvasElement; timeline: HTMLCanvasElement } | undefined;
  let ringWidth = 0, ringRatio = 1, ringSpp = WATERFALL_SAMPLES_PER_CSS_PIXEL, ringRate = 48_000;
  let originPosition = 0, clearedX = 0;

  function pixelRatio(): number { return Math.max(1, window.devicePixelRatio || 1); }

  function makeRing(cssHeight: number): HTMLCanvasElement {
    const ring = document.createElement('canvas');
    ring.width = ringWidth; ring.height = Math.max(1, Math.round(cssHeight * ringRatio));
    const ctx = ring.getContext('2d', { alpha: false })!;
    ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, ring.width, ring.height);
    return ring;
  }

  function ensureRings(): void {
    const ratio = pixelRatio();
    if (rings && ringRatio === ratio && ringSpp === samplesPerCssPixel && ringRate === sampleRate) return;
    ringRatio = ratio; ringSpp = samplesPerCssPixel; ringRate = sampleRate;
    ringWidth = Math.min(WATERFALL_MAX_RING_PIXELS,
      Math.ceil(waterfallPixelAdvance(WATERFALL_HISTORY_SECONDS * sampleRate, ratio, samplesPerCssPixel)));
    rings = { symbol: makeRing(SYMBOL_HEIGHT), confidence: makeRing(CONFIDENCE_HEIGHT), timeline: makeRing(TIMELINE_HEIGHT) };
    originPosition = Math.max(0, latestPosition); clearedX = 0;
    lastPaintedPosition = latestPosition;
    waterfallScrubSamples.set(0);
  }

  function xOf(position: number): number {
    return waterfallPixelAdvance(position - originPosition, ringRatio, ringSpp);
  }

  function ensureCleared(x: number): void {
    if (!rings || x <= clearedX) return;
    for (const ring of [rings.symbol, rings.confidence, rings.timeline]) {
      const ctx = ring.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#050a18';
      for (const span of ringSpans(clearedX, x - clearedX, ringWidth)) ctx.fillRect(span.x, 0, span.w, ring.height);
    }
    clearedX = x;
  }

  function resetLanes(): void {
    rings = undefined;
    renderedPosition = -1; latestPosition = -1; lastPaintedPosition = -1;
    waterfallScrubSamples.set(0);
  }

  function confidenceColor(value: number): string {
    if (value < 0.25) return '#e95770';
    if (value < 0.5) return '#ee944b';
    if (value < 0.75) return '#e8cd57';
    return '#4ee8b4';
  }

  function ingest() {
    if (!scores.length || sequence === lastSequence || samplePosition < 0) return;
    lastSequence = sequence;
    if (samplePosition < latestPosition) resetLanes();
    latestPosition = samplePosition;
    if (renderedPosition < 0) renderedPosition = samplePosition;
    ensureRings();
    if (lastPaintedPosition < 0) { lastPaintedPosition = samplePosition; return; }

    if (pendingScores.length !== scores.length) pendingScores = new Float32Array(scores.length);
    for (let index = 0; index < scores.length; index++) pendingScores[index] = Math.max(pendingScores[index], scores[index]);
    pendingConfidence = Math.max(pendingConfidence, confidence);

    const columnWidth = Math.floor(waterfallPixelAdvance(samplePosition - lastPaintedPosition, ringRatio, ringSpp));
    if (columnWidth < 1 || !rings) return;
    const columnEnd = Math.floor(xOf(samplePosition));
    ensureCleared(columnEnd);
    const symbolCtx = rings.symbol.getContext('2d', { alpha: false })!;
    const confidenceCtx = rings.confidence.getContext('2d', { alpha: false })!;
    const symbolHeight = rings.symbol.height, confidenceHeight = rings.confidence.height;
    const value = Math.max(0, Math.min(1, pendingConfidence));
    const barHeight = Math.max(1, Math.round(value * confidenceHeight));
    for (const span of ringSpans(columnEnd - columnWidth, columnWidth, ringWidth)) {
      const column = symbolCtx.createImageData(span.w, symbolHeight);
      for (let y = 0; y < symbolHeight; y++) {
        const symbol = Math.min(pendingScores.length - 1,
          Math.floor((symbolHeight - 1 - y) * pendingScores.length / symbolHeight));
        const [red, green, blue] = intensityToRgb(Math.sqrt(Math.max(0, Math.min(1, pendingScores[symbol]))));
        for (let x = 0; x < span.w; x++) {
          const offset = (y * span.w + x) * 4;
          column.data[offset] = red; column.data[offset + 1] = green; column.data[offset + 2] = blue; column.data[offset + 3] = 255;
        }
      }
      symbolCtx.putImageData(column, span.x, 0);
      confidenceCtx.fillStyle = '#050a18';
      confidenceCtx.fillRect(span.x, 0, span.w, confidenceHeight);
      confidenceCtx.fillStyle = confidenceColor(value);
      confidenceCtx.fillRect(span.x, confidenceHeight - barHeight, span.w, barHeight);
    }
    lastPaintedPosition += columnWidth * ringSpp / ringRatio;
    pendingScores.fill(0);
    pendingConfidence = 0;
  }

  function drawTimelineMarkers() {
    if (!rings || renderedPosition < 0) return;
    const ctx = rings.timeline.getContext('2d', { alpha: false })!;
    const ratio = ringRatio;
    for (const marker of markers) {
      if (marker.id <= lastMarkerId) continue;
      // Stale markers from a previous listening session can never scroll into view.
      if (marker.position > latestPosition + 10 * DETECTOR_HOP_SAMPLES) { lastMarkerId = marker.id; continue; }
      // Anchor to captured-signal time; defer markers the clock has not reached yet.
      if (marker.position > renderedPosition) break;
      lastMarkerId = marker.id;
      const rightUnwrapped = Math.floor(xOf(marker.position));
      ensureCleared(rightUnwrapped);
      const span = Math.max(2 * ratio, waterfallPixelAdvance(
        marker.symbols * sampleRate / Math.max(1, symbolRate), ratio, ringSpp
      ));
      const rightBase = ((rightUnwrapped % ringWidth) + ringWidth) % ringWidth;
      const draws = rightBase - span < 0 && rightUnwrapped >= ringWidth ? [rightBase, rightBase + ringWidth] : [rightBase];
      for (const right of draws) {
        const left = right - span;
        const top = 5 * ratio, tickBottom = 11 * ratio;
        const crcError = marker.label === '✕', crcConfirm = marker.label === '✓';
        ctx.strokeStyle = crcError ? '#ff5578' : crcConfirm ? '#4ee8b4' : '#ff718d';
        ctx.lineWidth = Math.max(1, ratio);
        ctx.beginPath(); ctx.moveTo(left, tickBottom); ctx.lineTo(left, top);
        ctx.lineTo(right, top); ctx.lineTo(right, tickBottom); ctx.stroke();
        ctx.fillStyle = crcError ? '#ff8da8' : crcConfirm ? '#4ee8b4' : '#dcecff';
        ctx.font = `${Math.round(10 * ratio)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(marker.label, (left + right) / 2, 23 * ratio);
      }
    }
  }

  function maxScrubSamples(): number {
    if (!rings || renderedPosition < 0) return 0;
    const capacityPx = Math.max(0, ringWidth - Math.round(width * ringRatio));
    return Math.max(0, Math.min(renderedPosition - originPosition, capacityPx * ringSpp / ringRatio));
  }

  function blitLane(ring: HTMLCanvasElement, visible: HTMLCanvasElement) {
    const ctx = visible.getContext('2d', { alpha: false });
    if (!ctx) return;
    const pixelWidth = Math.max(1, Math.round(width * ringRatio));
    const pixelHeight = ring.height;
    if (visible.width !== pixelWidth || visible.height !== pixelHeight) {
      visible.width = pixelWidth; visible.height = pixelHeight;
    }
    ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    const headX = Math.floor(xOf(renderedPosition));
    const backPx = Math.floor(waterfallPixelAdvance(
      Math.min(scrubSamples, maxScrubSamples()), ringRatio, ringSpp));
    const end = headX - backPx;
    let start = end - pixelWidth, dx = 0;
    const oldest = Math.max(0, headX - ringWidth + 1);
    if (start < oldest) { dx = oldest - start; start = oldest; }
    if (end <= start) return;
    for (const span of ringSpans(start, end - start, ringWidth)) {
      ctx.drawImage(ring, span.x, 0, span.w, pixelHeight, dx, 0, span.w, pixelHeight);
      dx += span.w;
    }
  }

  function blit() {
    if (!rings || renderedPosition < 0 || !canvas) return;
    blitLane(rings.symbol, canvas);
    blitLane(rings.confidence, confidenceCanvas);
    blitLane(rings.timeline, timelineCanvas);
  }

  // CSS-pixel x of the replay playback cursor within the viewport, or -1 when hidden.
  let sweepLeft = -1;
  function updateSweep() {
    const position = $replayPlaybackPosition;
    if (position < 0 || !rings || renderedPosition < 0) { sweepLeft = -1; return; }
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

  $: scores, confidence, sequence, samplePosition, samplesPerCssPixel, ingest();
  $: markers, drawTimelineMarkers();

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => { width = Math.max(280, Math.floor(entry.contentRect.width)); });
    resize.observe(host);
    let frame = 0, lastTime = -1;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (renderedPosition < 0 || latestPosition < 0) { lastTime = now; return; }
      const rawDt = lastTime > 0 ? (now - lastTime) / 1000 : 0;
      if (rawDt > 0.25 && document.visibilityState === 'visible') {
        console.warn(`Main-thread hitch: ${Math.round(rawDt * 1000)} ms between animation frames`);
      }
      const dt = Math.min(0.1, Math.max(0, rawDt));
      lastTime = now;
      // Free-run at the audio rate with bounded catch-up when the worker is behind,
      // easing to a stop within two hops ahead of the data so the live edge stays
      // pinned to the display's right edge instead of scrolling into blank canvas.
      // More than a second behind (e.g. returning to a background-throttled tab):
      // jump to the data head; the scrub offset is delay-from-live, so it is kept.
      const lag = latestPosition - renderedPosition;
      if (lag > sampleRate) {
        renderedPosition = latestPosition;
      } else {
        const factor = lag >= 0 ? Math.min(8, 1 + 2 * lag / sampleRate)
          : Math.max(0, 1 + lag / (2 * DETECTOR_HOP_SAMPLES));
        renderedPosition = Math.min(renderedPosition + dt * sampleRate * factor,
          latestPosition + 2 * DETECTOR_HOP_SAMPLES);
      }
      ensureRings();
      ensureCleared(Math.floor(xOf(renderedPosition)));
      drawTimelineMarkers();
      blit();
      updateSweep();
      waterfallView.set({ position: renderedPosition, viewSamples: width * samplesPerCssPixel });
    };
    frame = requestAnimationFrame(tick);
    return () => { resize.disconnect(); cancelAnimationFrame(frame); };
  });
</script>

<div class="figure" bind:this={host} data-testid="symbol-waterfall" data-samples-per-css-pixel={samplesPerCssPixel} aria-label="FSK symbol likelihood waterfall; newest detections at right" role="img">
  <div class="plot"><div class="labels">{#each displayLabels as label}<span>{label}</span>{/each}</div><div class="detector scrub" class:scrubbed={scrubSamples > 0} role="presentation" on:pointerdown={scrubStart} on:pointermove={scrubMove} on:pointerup={scrubEnd} on:pointercancel={scrubEnd}><canvas bind:this={canvas} aria-hidden="true"></canvas>{#if sweepLeft >= 0}<div class="sweep" data-testid="replay-sweep" style={`left:${sweepLeft.toFixed(2)}px`} aria-hidden="true"></div>{/if}{#if scrubSamples > 0}<button class="live" on:pointerdown|stopPropagation on:click={() => waterfallScrubSamples.set(0)}>◀ {(scrubSamples / sampleRate).toFixed(1)}s · LIVE ▶</button>{/if}</div></div>
  <div class="confidence"><span class="channel">CONF</span><div class="confidence-history scrub" aria-label="Scrolling FSK symbol confidence history" role="img" on:pointerdown={scrubStart} on:pointermove={scrubMove} on:pointerup={scrubEnd} on:pointercancel={scrubEnd}><canvas bind:this={confidenceCanvas} aria-hidden="true"></canvas></div></div>
  <div class="timeline"><span class="channel">RX TIME</span><div class="timeline-history scrub" aria-label="Scrolling decoded FSK character timing" role="img" on:pointerdown={scrubStart} on:pointermove={scrubMove} on:pointerup={scrubEnd} on:pointercancel={scrubEnd}><canvas bind:this={timelineCanvas} aria-hidden="true"></canvas></div></div>
  <div class="receive"><span class="channel">RX</span><div class="messages"><span>{#each [...recentMessages] as character}<i class:confirm={character === '✓'} class:error={character === '✕'}>{character}</i>{/each}</span></div></div>
</div>

<style>
  .figure { width:100%; }
  .plot { display:grid; grid-template-columns:62px 1fr; gap:7px; }
  .detector { position:relative; width:100%; min-width:0; height:150px; overflow:hidden; border-radius:12px; background:#050a18; }
  canvas { display:block; width:100%; height:150px; }
  .labels { display:grid; grid-template-rows:repeat(auto-fit,minmax(1px,1fr)); color:#8294aa; font:9px ui-monospace,monospace; }
  .labels span { display:flex; align-items:center; justify-content:flex-end; }
  .receive,.confidence,.timeline { display:grid; grid-template-columns:62px 1fr; gap:7px; margin-top:6px; min-width:0; }
  .channel { color:#8294aa; font:10px ui-monospace,monospace; text-align:right; padding-top:5px; }
  .confidence-history { height:22px; overflow:hidden; border:1px solid #203149; border-radius:5px; background:#050a18; }
  .confidence-history canvas { width:100%; height:22px; }
  .timeline-history { height:34px; overflow:hidden; border:1px solid #203149; border-radius:5px; background:#050a18; }
  .timeline-history canvas { width:100%; height:34px; }
  .scrub { cursor:grab; touch-action:none; }
  .scrub.scrubbed, .scrub:active { cursor:grabbing; }
  .live { position:absolute; top:7px; right:9px; border:1px solid #2c8e6f; border-radius:99px; padding:4px 10px; background:#0b2c22e6; color:#4ee8b4; font:600 10px ui-monospace,monospace; cursor:pointer; }
  .sweep { position:absolute; top:0; bottom:0; width:2px; margin-left:-1px; background:#ff4b63; box-shadow:0 0 7px #ff4b63b0; pointer-events:none; }
  .messages { height:27px; display:flex; align-items:center; justify-content:flex-end; overflow:hidden; padding:4px 8px; border:1px solid #203149; border-radius:7px; background:#050a18; color:#cfe3ff; font:11px ui-monospace,monospace; white-space:pre; }
  .messages span { flex:0 0 auto; }
  .messages i { font:inherit; font-style:normal; }.messages i.confirm{color:#4ee8b4;font-weight:800}.messages i.error{color:#ff8da8;font-weight:800}
</style>
