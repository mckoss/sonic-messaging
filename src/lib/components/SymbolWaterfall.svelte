<script lang="ts">
  import { onMount } from 'svelte';
  import { intensityToRgb } from '../audio/waterfall';

  export let scores: Float32Array = new Float32Array();
  export let labels: string[] = [];
  export let sequence = -1;
  export let tokens: string[] = [];
  export let confidence = 0;

  let canvas: HTMLCanvasElement;
  let confidenceCanvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let width = 800, height = 150, lastSequence = -1, lastConfidenceSequence = -1;

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
    const columnWidth = Math.max(1, Math.round(2 * ratio));
    ctx.drawImage(canvas, columnWidth, 0, pixelWidth - columnWidth, pixelHeight, 0, 0, pixelWidth - columnWidth, pixelHeight);
    const column = ctx.createImageData(columnWidth, pixelHeight);
    for (let y = 0; y < pixelHeight; y++) {
      const symbol = Math.min(scores.length - 1, Math.floor(y * scores.length / pixelHeight));
      const [red, green, blue] = intensityToRgb(Math.sqrt(Math.max(0, Math.min(1, scores[symbol]))));
      for (let x = 0; x < columnWidth; x++) {
        const offset = (y * columnWidth + x) * 4;
        column.data[offset] = red; column.data[offset + 1] = green; column.data[offset + 2] = blue; column.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(column, pixelWidth - columnWidth, 0);
    lastSequence = sequence;
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
    const columnWidth = Math.max(1, Math.round(2 * ratio));
    ctx.drawImage(confidenceCanvas, columnWidth, 0, pixelWidth - columnWidth, pixelHeight,
      0, 0, pixelWidth - columnWidth, pixelHeight);
    ctx.fillStyle = '#050a18'; ctx.fillRect(pixelWidth - columnWidth, 0, columnWidth, pixelHeight);
    const value = Math.max(0, Math.min(1, confidence));
    const barHeight = Math.max(1, Math.round(value * pixelHeight));
    ctx.fillStyle = confidenceColor(value);
    ctx.fillRect(pixelWidth - columnWidth, pixelHeight - barHeight, columnWidth, barHeight);
    lastConfidenceSequence = sequence;
  }

  $: scores, sequence, width, height, draw();
  $: confidence, sequence, width, drawConfidence();

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => { width = Math.max(280, Math.floor(entry.contentRect.width)); });
    resize.observe(host);
    return () => resize.disconnect();
  });
</script>

<div class="figure" bind:this={host} aria-label="FSK symbol likelihood waterfall; newest detections at right" role="img">
  <div class="plot"><div class="labels">{#each labels as label}<span>{label}</span>{/each}</div><div class="detector"><canvas bind:this={canvas} aria-hidden="true"></canvas></div></div>
  <div class="confidence"><span class="channel">CONF</span><div class="confidence-history" aria-label="Scrolling FSK symbol confidence history" role="img"><canvas bind:this={confidenceCanvas} aria-hidden="true"></canvas></div></div>
  <div class="receive"><span class="channel">RX</span><div class="tokens">{#each tokens as token}<span class:confirm={token === '<SYNC>' || token === '<CRC-Confirm>'} class:error={token === '<CRC-Error>'}>{token === ' ' ? '␠' : token}</span>{/each}</div></div>
</div>

<style>
  .figure { width:100%; }
  .plot { display:grid; grid-template-columns:auto 1fr; gap:7px; }
  .detector { width:100%; min-width:0; height:150px; overflow:hidden; border-radius:12px; background:#050a18; }
  canvas { display:block; width:100%; height:150px; }
  .labels { display:grid; grid-template-rows:repeat(auto-fit,minmax(1px,1fr)); color:#8294aa; font:9px ui-monospace,monospace; }
  .labels span { display:flex; align-items:center; justify-content:flex-end; }
  .receive,.confidence { display:grid; grid-template-columns:38px 1fr; gap:7px; margin-top:6px; min-width:0; }
  .channel { color:#8294aa; font:10px ui-monospace,monospace; text-align:right; padding-top:5px; }
  .confidence-history { height:22px; overflow:hidden; border:1px solid #203149; border-radius:5px; background:#050a18; }
  .confidence-history canvas { width:100%; height:22px; }
  .tokens { height:27px; display:flex; align-items:center; justify-content:flex-end; gap:9px; overflow:hidden; padding:4px 8px; border:1px solid #203149; border-radius:7px; background:#050a18; color:#cfe3ff; font:11px ui-monospace,monospace; white-space:pre; }
  .tokens span { flex:0 0 auto; }.tokens .confirm { color:#4ee8b4; font-weight:700; }.tokens .error { color:#ff8da8; font-weight:700; }
</style>
