<script lang="ts">
  import { onMount } from 'svelte';
  import { DETECTOR_HOP_SAMPLES, intensityToRgb, WATERFALL_SAMPLES_PER_CSS_PIXEL, waterfallPixelAdvance } from '../audio/waterfall';

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

  let canvas: HTMLCanvasElement;
  let confidenceCanvas: HTMLCanvasElement;
  let timelineCanvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800, height = 150;
  // The lanes scroll on their own animation clock (sample-time at the right edge),
  // rate-locked to the worker's sample positions; late worker data paints behind the edge.
  let renderedPosition = -1, latestPosition = -1, scrollRemainder = 0;
  let lastSequence = -1, lastPaintedPosition = -1, lastMarkerId = -1;
  let pendingScores = new Float32Array(0), pendingConfidence = 0;

  function pixelRatio(): number { return Math.max(1, window.devicePixelRatio || 1); }

  function laneContext(target: HTMLCanvasElement, cssHeight: number) {
    const ctx = target.getContext('2d', { alpha: false });
    if (!ctx) return undefined;
    const ratio = pixelRatio();
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));
    if (target.width !== pixelWidth || target.height !== pixelHeight) {
      target.width = pixelWidth; target.height = pixelHeight;
      ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    }
    return { ctx, ratio, pixelWidth, pixelHeight };
  }

  function scrollLane(target: HTMLCanvasElement, cssHeight: number, advance: number) {
    const lane = laneContext(target, cssHeight);
    if (!lane || advance < 1) return;
    const { ctx, pixelWidth, pixelHeight } = lane;
    const shift = Math.min(pixelWidth, advance);
    ctx.drawImage(target, shift, 0, pixelWidth - shift, pixelHeight, 0, 0, pixelWidth - shift, pixelHeight);
    ctx.fillStyle = '#050a18'; ctx.fillRect(pixelWidth - shift, 0, shift, pixelHeight);
  }

  function resetLanes() {
    renderedPosition = -1; latestPosition = -1; scrollRemainder = 0; lastPaintedPosition = -1;
    for (const target of [canvas, confidenceCanvas, timelineCanvas]) {
      const ctx = target?.getContext('2d', { alpha: false });
      if (ctx && target) { ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, target.width, target.height); }
    }
  }

  function confidenceColor(value: number): string {
    if (value < 0.25) return '#e95770';
    if (value < 0.5) return '#ee944b';
    if (value < 0.75) return '#e8cd57';
    return '#4ee8b4';
  }

  function ingest() {
    if (!canvas || !scores.length || sequence === lastSequence || samplePosition < 0) return;
    lastSequence = sequence;
    if (samplePosition < latestPosition) resetLanes();
    latestPosition = samplePosition;
    if (renderedPosition < 0) renderedPosition = samplePosition;
    if (lastPaintedPosition < 0) { lastPaintedPosition = samplePosition; return; }

    if (pendingScores.length !== scores.length) pendingScores = new Float32Array(scores.length);
    for (let index = 0; index < scores.length; index++) pendingScores[index] = Math.max(pendingScores[index], scores[index]);
    pendingConfidence = Math.max(pendingConfidence, confidence);

    const symbolLane = laneContext(canvas, 150);
    const confidenceLane = laneContext(confidenceCanvas, 22);
    if (!symbolLane || !confidenceLane) return;
    const { ratio, pixelWidth, pixelHeight } = symbolLane;
    const columnWidth = Math.floor(waterfallPixelAdvance(samplePosition - lastPaintedPosition, ratio, samplesPerCssPixel));
    if (columnWidth < 1) return;
    lastPaintedPosition += columnWidth * samplesPerCssPixel / ratio;
    const behind = Math.max(0, Math.round(waterfallPixelAdvance(renderedPosition - samplePosition, ratio, samplesPerCssPixel)));
    const columnEnd = pixelWidth - behind;
    const columnStart = columnEnd - Math.min(columnWidth, pixelWidth);
    if (columnEnd >= 1) {
      const clippedStart = Math.max(0, columnStart), clippedWidth = columnEnd - clippedStart;
      const column = symbolLane.ctx.createImageData(clippedWidth, pixelHeight);
      for (let y = 0; y < pixelHeight; y++) {
        const symbol = Math.min(pendingScores.length - 1,
          Math.floor((pixelHeight - 1 - y) * pendingScores.length / pixelHeight));
        const [red, green, blue] = intensityToRgb(Math.sqrt(Math.max(0, Math.min(1, pendingScores[symbol]))));
        for (let x = 0; x < clippedWidth; x++) {
          const offset = (y * clippedWidth + x) * 4;
          column.data[offset] = red; column.data[offset + 1] = green; column.data[offset + 2] = blue; column.data[offset + 3] = 255;
        }
      }
      symbolLane.ctx.putImageData(column, clippedStart, 0);

      const value = Math.max(0, Math.min(1, pendingConfidence));
      const barHeight = Math.max(1, Math.round(value * confidenceLane.pixelHeight));
      confidenceLane.ctx.fillStyle = '#050a18';
      confidenceLane.ctx.fillRect(clippedStart, 0, clippedWidth, confidenceLane.pixelHeight);
      confidenceLane.ctx.fillStyle = confidenceColor(value);
      confidenceLane.ctx.fillRect(clippedStart, confidenceLane.pixelHeight - barHeight, clippedWidth, barHeight);
    }
    pendingScores.fill(0);
    pendingConfidence = 0;
  }

  function drawMarkers() {
    if (!timelineCanvas || !markers.length || renderedPosition < 0) return;
    const lane = laneContext(timelineCanvas, 34);
    if (!lane) return;
    const { ctx, ratio, pixelWidth } = lane;
    for (const marker of markers) {
      if (marker.id <= lastMarkerId) continue;
      // Stale markers from a previous listening session can never scroll into view.
      if (marker.position > latestPosition + 10 * DETECTOR_HOP_SAMPLES) { lastMarkerId = marker.id; continue; }
      // Anchor to captured-signal time; defer markers the clock has not reached yet.
      if (marker.position > renderedPosition) break;
      lastMarkerId = marker.id;
      const behind = waterfallPixelAdvance(renderedPosition - marker.position, ratio, samplesPerCssPixel);
      const right = pixelWidth - ratio - behind;
      if (right < 1) continue;
      const span = Math.max(2 * ratio, waterfallPixelAdvance(
        marker.symbols * sampleRate / Math.max(1, symbolRate), ratio, samplesPerCssPixel
      ));
      const left = Math.max(0, right - span);
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

  $: scores, confidence, sequence, samplePosition, samplesPerCssPixel, width, ingest();
  $: markers, drawMarkers();

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => { width = Math.max(280, Math.floor(entry.contentRect.width)); });
    resize.observe(host);
    let frame = 0, lastTime = -1;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (renderedPosition < 0 || latestPosition < 0) { lastTime = now; return; }
      const dt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      // Free-run at the audio rate with proportional catch-up toward the worker's
      // clock, capped just ahead of the latest data so a stalled worker pauses us.
      const lag = latestPosition - renderedPosition;
      const advanceSamples = Math.max(0, dt * (sampleRate + 2 * lag));
      const next = Math.min(renderedPosition + advanceSamples, latestPosition + 2 * DETECTOR_HOP_SAMPLES);
      const ratio = pixelRatio();
      scrollRemainder += waterfallPixelAdvance(next - renderedPosition, ratio, samplesPerCssPixel);
      renderedPosition = next;
      const advance = Math.floor(scrollRemainder);
      if (advance >= 1) {
        scrollRemainder -= advance;
        scrollLane(canvas, 150, advance);
        scrollLane(confidenceCanvas, 22, advance);
        scrollLane(timelineCanvas, 34, advance);
      }
      drawMarkers();
    };
    frame = requestAnimationFrame(tick);
    return () => { resize.disconnect(); cancelAnimationFrame(frame); };
  });
</script>

<div class="figure" bind:this={host} data-testid="symbol-waterfall" data-samples-per-css-pixel={samplesPerCssPixel} aria-label="FSK symbol likelihood waterfall; newest detections at right" role="img">
  <div class="plot"><div class="labels">{#each displayLabels as label}<span>{label}</span>{/each}</div><div class="detector"><canvas bind:this={canvas} aria-hidden="true"></canvas></div></div>
  <div class="confidence"><span class="channel">CONF</span><div class="confidence-history" aria-label="Scrolling FSK symbol confidence history" role="img"><canvas bind:this={confidenceCanvas} aria-hidden="true"></canvas></div></div>
  <div class="timeline"><span class="channel">RX TIME</span><div class="timeline-history" aria-label="Scrolling decoded FSK character timing" role="img"><canvas bind:this={timelineCanvas} aria-hidden="true"></canvas></div></div>
  <div class="receive"><span class="channel">RX</span><div class="messages"><span>{#each [...recentMessages] as character}<i class:confirm={character === '✓'} class:error={character === '✕'}>{character}</i>{/each}</span></div></div>
</div>

<style>
  .figure { width:100%; }
  .plot { display:grid; grid-template-columns:62px 1fr; gap:7px; }
  .detector { width:100%; min-width:0; height:150px; overflow:hidden; border-radius:12px; background:#050a18; }
  canvas { display:block; width:100%; height:150px; }
  .labels { display:grid; grid-template-rows:repeat(auto-fit,minmax(1px,1fr)); color:#8294aa; font:9px ui-monospace,monospace; }
  .labels span { display:flex; align-items:center; justify-content:flex-end; }
  .receive,.confidence,.timeline { display:grid; grid-template-columns:62px 1fr; gap:7px; margin-top:6px; min-width:0; }
  .channel { color:#8294aa; font:10px ui-monospace,monospace; text-align:right; padding-top:5px; }
  .confidence-history { height:22px; overflow:hidden; border:1px solid #203149; border-radius:5px; background:#050a18; }
  .confidence-history canvas { width:100%; height:22px; }
  .timeline-history { height:34px; overflow:hidden; border:1px solid #203149; border-radius:5px; background:#050a18; }
  .timeline-history canvas { width:100%; height:34px; }
  .messages { height:27px; display:flex; align-items:center; justify-content:flex-end; overflow:hidden; padding:4px 8px; border:1px solid #203149; border-radius:7px; background:#050a18; color:#cfe3ff; font:11px ui-monospace,monospace; white-space:pre; }
  .messages span { flex:0 0 auto; }
  .messages i { font:inherit; font-style:normal; }.messages i.confirm{color:#4ee8b4;font-weight:800}.messages i.error{color:#ff8da8;font-weight:800}
</style>
