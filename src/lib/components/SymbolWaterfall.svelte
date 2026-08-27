<script lang="ts">
  import { onMount } from 'svelte';
  import { intensityToRgb, waterfallPixelAdvance } from '../audio/waterfall';

  export let scores: Float32Array = new Float32Array();
  export let labels: string[] = [];
  export let sequence = -1;
  export let messages: string[] = [];
  export let markers: Array<{ id: number; label: string; symbols: number }> = [];
  export let confidence = 0;
  export let sampleRate = 48_000;
  export let symbolRate = 100;

  $: recentMessages = messages.length ? `| ${messages.join(' | ')} |` : '';

  let canvas: HTMLCanvasElement;
  let confidenceCanvas: HTMLCanvasElement;
  let timelineCanvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800, height = 150, lastSequence = -1, lastConfidenceSequence = -1;
  let symbolPixelRemainder = 0, confidencePixelRemainder = 0;
  let timelinePixelRemainder = 0, lastTimelineSequence = -1, lastMarkerId = -1;
  let pendingScores = new Float32Array(0), pendingConfidence = 0;

  function pixelAdvance(ratio: number): number {
    return waterfallPixelAdvance(sampleRate / Math.max(1, symbolRate), ratio);
  }

  function draw() {
    if (!canvas || !scores.length || sequence === lastSequence) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
      ctx.fillStyle = 'rgb(5, 10, 24)'; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    }
    if (pendingScores.length !== scores.length) pendingScores = new Float32Array(scores.length);
    for (let index = 0; index < scores.length; index++) pendingScores[index] = Math.max(pendingScores[index], scores[index]);
    symbolPixelRemainder += pixelAdvance(ratio);
    const columnWidth = Math.floor(symbolPixelRemainder);
    lastSequence = sequence;
    if (columnWidth < 1) return;
    symbolPixelRemainder -= columnWidth;
    ctx.drawImage(canvas, columnWidth, 0, pixelWidth - columnWidth, pixelHeight, 0, 0, pixelWidth - columnWidth, pixelHeight);
    const column = ctx.createImageData(columnWidth, pixelHeight);
    for (let y = 0; y < pixelHeight; y++) {
      const symbol = Math.min(pendingScores.length - 1, Math.floor(y * pendingScores.length / pixelHeight));
      const [red, green, blue] = intensityToRgb(Math.sqrt(Math.max(0, Math.min(1, pendingScores[symbol]))));
      for (let x = 0; x < columnWidth; x++) {
        const offset = (y * columnWidth + x) * 4;
        column.data[offset] = red; column.data[offset + 1] = green; column.data[offset + 2] = blue; column.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(column, pixelWidth - columnWidth, 0);
    pendingScores.fill(0);
  }

  function confidenceColor(value: number): string {
    if (value < 0.25) return '#e95770';
    if (value < 0.5) return '#ee944b';
    if (value < 0.75) return '#e8cd57';
    return '#4ee8b4';
  }

  function drawConfidence() {
    if (!confidenceCanvas || sequence === lastConfidenceSequence) return;
    const ctx = confidenceCanvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(22 * ratio));
    if (confidenceCanvas.width !== pixelWidth || confidenceCanvas.height !== pixelHeight) {
      confidenceCanvas.width = pixelWidth; confidenceCanvas.height = pixelHeight;
      ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    }
    pendingConfidence = Math.max(pendingConfidence, confidence);
    confidencePixelRemainder += pixelAdvance(ratio);
    const columnWidth = Math.floor(confidencePixelRemainder);
    lastConfidenceSequence = sequence;
    if (columnWidth < 1) return;
    confidencePixelRemainder -= columnWidth;
    ctx.drawImage(confidenceCanvas, columnWidth, 0, pixelWidth - columnWidth, pixelHeight,
      0, 0, pixelWidth - columnWidth, pixelHeight);
    ctx.fillStyle = '#050a18'; ctx.fillRect(pixelWidth - columnWidth, 0, columnWidth, pixelHeight);
    const value = Math.max(0, Math.min(1, pendingConfidence));
    const barHeight = Math.max(1, Math.round(value * pixelHeight));
    ctx.fillStyle = confidenceColor(value);
    ctx.fillRect(pixelWidth - columnWidth, pixelHeight - barHeight, columnWidth, barHeight);
    pendingConfidence = 0;
  }

  function prepareTimeline(ctx: CanvasRenderingContext2D, ratio: number) {
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(34 * ratio));
    if (timelineCanvas.width !== pixelWidth || timelineCanvas.height !== pixelHeight) {
      timelineCanvas.width = pixelWidth; timelineCanvas.height = pixelHeight;
      ctx.fillStyle = '#050a18'; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    }
    return { pixelWidth, pixelHeight };
  }

  function scrollTimeline() {
    if (!timelineCanvas || sequence === lastTimelineSequence) return;
    const ctx = timelineCanvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const { pixelWidth, pixelHeight } = prepareTimeline(ctx, ratio);
    timelinePixelRemainder += pixelAdvance(ratio);
    const advance = Math.floor(timelinePixelRemainder);
    lastTimelineSequence = sequence;
    if (advance < 1) return;
    timelinePixelRemainder -= advance;
    ctx.drawImage(timelineCanvas, advance, 0, pixelWidth - advance, pixelHeight,
      0, 0, pixelWidth - advance, pixelHeight);
    ctx.fillStyle = '#050a18'; ctx.fillRect(pixelWidth - advance, 0, advance, pixelHeight);
  }

  function drawMarkers() {
    if (!timelineCanvas || !markers.length) return;
    const pending = markers.filter(marker => marker.id > lastMarkerId);
    if (!pending.length) return;
    const ctx = timelineCanvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const { pixelWidth } = prepareTimeline(ctx, ratio);
    for (const marker of pending) {
      const span = Math.max(2 * ratio, waterfallPixelAdvance(
        marker.symbols * sampleRate / Math.max(1, symbolRate), ratio
      ));
      const right = pixelWidth - ratio, left = Math.max(0, right - span);
      const top = 5 * ratio, tickBottom = 11 * ratio;
      ctx.strokeStyle = marker.label === '<CRC-Error>' ? '#ff5578' : '#ff718d';
      ctx.lineWidth = Math.max(1, ratio);
      ctx.beginPath(); ctx.moveTo(left, tickBottom); ctx.lineTo(left, top);
      ctx.lineTo(right, top); ctx.lineTo(right, tickBottom); ctx.stroke();
      ctx.fillStyle = marker.label === '<CRC-Error>' ? '#ff8da8' : '#dcecff';
      ctx.font = `${Math.round(10 * ratio)}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(marker.label, (left + right) / 2, 23 * ratio);
      lastMarkerId = marker.id;
    }
  }

  $: scores, sequence, width, height, draw();
  $: confidence, sequence, width, drawConfidence();
  $: sequence, width, scrollTimeline();
  $: markers, width, drawMarkers();

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => { width = Math.max(280, Math.floor(entry.contentRect.width)); });
    resize.observe(host);
    return () => resize.disconnect();
  });
</script>

<div class="figure" bind:this={host} aria-label="FSK symbol likelihood waterfall; newest detections at right" role="img">
  <div class="plot"><div class="labels">{#each labels as label}<span>{label}</span>{/each}</div><div class="detector"><canvas bind:this={canvas} aria-hidden="true"></canvas></div></div>
  <div class="confidence"><span class="channel">CONF</span><div class="confidence-history" aria-label="Scrolling FSK symbol confidence history" role="img"><canvas bind:this={confidenceCanvas} aria-hidden="true"></canvas></div></div>
  <div class="timeline"><span class="channel">RX TIME</span><div class="timeline-history" aria-label="Scrolling decoded FSK character timing" role="img"><canvas bind:this={timelineCanvas} aria-hidden="true"></canvas></div></div>
  <div class="receive"><span class="channel">RX</span><div class="messages"><span>{recentMessages}</span></div></div>
</div>

<style>
  .figure { width:100%; }
  .plot { display:grid; grid-template-columns:auto 1fr; gap:7px; }
  .detector { width:100%; min-width:0; height:150px; overflow:hidden; border-radius:12px; background:#050a18; }
  canvas { display:block; width:100%; height:150px; }
  .labels { display:grid; grid-template-rows:repeat(auto-fit,minmax(1px,1fr)); color:#8294aa; font:9px ui-monospace,monospace; }
  .labels span { display:flex; align-items:center; justify-content:flex-end; }
  .receive,.confidence,.timeline { display:grid; grid-template-columns:45px 1fr; gap:7px; margin-top:6px; min-width:0; }
  .channel { color:#8294aa; font:10px ui-monospace,monospace; text-align:right; padding-top:5px; }
  .confidence-history { height:22px; overflow:hidden; border:1px solid #203149; border-radius:5px; background:#050a18; }
  .confidence-history canvas { width:100%; height:22px; }
  .timeline-history { height:34px; overflow:hidden; border:1px solid #203149; border-radius:5px; background:#050a18; }
  .timeline-history canvas { width:100%; height:34px; }
  .messages { height:27px; display:flex; align-items:center; justify-content:flex-end; overflow:hidden; padding:4px 8px; border:1px solid #203149; border-radius:7px; background:#050a18; color:#cfe3ff; font:11px ui-monospace,monospace; white-space:pre; }
  .messages span { flex:0 0 auto; }
</style>
